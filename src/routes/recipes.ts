import { and, desc, eq, inArray, asc } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Db } from '../db/client';
import {
  inventoryLots,
  recipeSuggestions,
  type InventoryLot,
  type User,
} from '../db/schema';
import { assertHouseholdAccess } from '../lib/access';
import { daysUntil, todayUtc } from '../lib/datetime';
import { ApiError } from '../lib/errors';
import { GeminiError } from '../lib/geminiClient';
import { newId } from '../lib/id';
import {
  historyQuerySchema,
  parseJsonBody,
  parseQuery,
  recipeSuggestSchema,
} from '../lib/validators';
import { suggestRecipes } from '../services/recipeService';
import type { AppEnv } from '../types';

/** /households にマウント */
export const recipesRoute = new Hono<AppEnv>();

type BasedOnItem = {
  inventory_lot_id: string;
  display_name: string;
  expires_on: string;
  quantity: number;
  unit: string;
  days_until_expiry: number;
};

/**
 * Gemini呼び出し＋レスポンス整形の共通処理。
 * 提案が得られたら recipe_suggestions に履歴として保存する。
 * 食材選択は必須（呼び出し側で lots.length === 0 にならないことを保証する）。
 */
async function buildRecipeResponse(
  env: AppEnv['Bindings'],
  db: Db,
  user: User,
  householdId: string,
  lots: InventoryLot[],
  today: string,
) {
  const items = lots.map((lot) => ({
    name: lot.displayName,
    expiresOn: lot.expiresOn,
    quantity: lot.quantity,
    unit: lot.unit,
  }));

  try {
    const { recipes, modelName } = await suggestRecipes(env, items);

    const basedOn: BasedOnItem[] = lots.map((lot) => ({
      inventory_lot_id: lot.id,
      display_name: lot.displayName,
      expires_on: lot.expiresOn,
      quantity: lot.quantity,
      unit: lot.unit,
      days_until_expiry: daysUntil(lot.expiresOn, today),
    }));

    await db.insert(recipeSuggestions).values({
      id: newId('rcs'),
      householdId,
      requestedBy: user.id,
      modelName,
      // 自動選択(GET)は廃止したため、常にユーザーが選んだ食材での提案になる
      selectionMode: 'selected',
      basedOnJson: JSON.stringify(basedOn),
      recipesJson: JSON.stringify(recipes),
    });

    return { recipes, based_on: basedOn, model_name: modelName };
  } catch (e) {
    if (e instanceof GeminiError) {
      // レート制限は 429、それ以外は 502 として返す
      const status = e.code === 'rate_limited' ? 429 : 502;
      throw new ApiError(status, `gemini_${e.code}`, e.message);
    }
    throw e;
  }
}

/**
 * POST /households/:id/recipes/suggestions
 * ユーザーが在庫一覧から選んだ食材だけでレシピを提案させる。
 * 「期限が近い順に自動選択して毎回Geminiを呼ぶ」自動提案は廃止した
 * （ユーザーが明示的に選んで送信した時だけAPIコストが発生するようにするため）。
 */
recipesRoute.post('/:id/recipes/suggestions', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const body = await parseJsonBody(c, recipeSuggestSchema);
  const today = todayUtc();

  const lots = await db
    .select()
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.householdId, householdId),
        eq(inventoryLots.status, 'active'),
        inArray(inventoryLots.id, body.inventory_lot_ids),
      ),
    )
    .orderBy(asc(inventoryLots.expiresOn), asc(inventoryLots.createdAt));

  if (lots.length === 0) {
    throw ApiError.badRequest(
      '指定された在庫が見つかりません（既に消費・廃棄済みの可能性があります）',
    );
  }

  const responseBody = await buildRecipeResponse(
    c.env, db, user, householdId, lots, today,
  );
  return c.json(responseBody);
});

/**
 * GET /households/:id/recipes/history
 * これまでにGeminiが提案したレシピの履歴一覧（新しい順）。
 */
recipesRoute.get('/:id/recipes/history', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const query = parseQuery(c, historyQuerySchema);

  const rows = await db
    .select()
    .from(recipeSuggestions)
    .where(eq(recipeSuggestions.householdId, householdId))
    .orderBy(desc(recipeSuggestions.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  const history = rows.map((row) => ({
    id: row.id,
    model_name: row.modelName,
    selection_mode: row.selectionMode,
    based_on: JSON.parse(row.basedOnJson) as BasedOnItem[],
    recipes: JSON.parse(row.recipesJson),
    created_at: row.createdAt,
  }));

  return c.json({ history, count: history.length });
});
