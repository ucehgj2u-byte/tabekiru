import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { inventoryLots } from '../db/schema';
import { assertHouseholdAccess } from '../lib/access';
import { addDays, daysUntil, todayUtc } from '../lib/datetime';
import { ApiError } from '../lib/errors';
import { GeminiError } from '../lib/geminiClient';
import { parseQuery, recipeQuerySchema } from '../lib/validators';
import { suggestRecipes } from '../services/recipeService';
import type { AppEnv } from '../types';

/** /households にマウント */
export const recipesRoute = new Hono<AppEnv>();

/**
 * GET /households/:id/recipes/suggestions
 * 期限が近い在庫を優先的に使うレシピを Gemini に提案させる。
 */
recipesRoute.get('/:id/recipes/suggestions', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const query = parseQuery(c, recipeQuerySchema);
  const today = todayUtc();

  const conditions = [
    eq(inventoryLots.householdId, householdId),
    eq(inventoryLots.status, 'active'),
  ];
  if (query.within_days !== undefined) {
    conditions.push(lte(inventoryLots.expiresOn, addDays(today, query.within_days)));
  }
  if (query.inventory_lot_ids) {
    conditions.push(inArray(inventoryLots.id, query.inventory_lot_ids));
  }

  const lots = await db
    .select()
    .from(inventoryLots)
    .where(and(...conditions))
    .orderBy(asc(inventoryLots.expiresOn), asc(inventoryLots.createdAt))
    .limit(query.limit);

  if (lots.length === 0) {
    return c.json({
      recipes: [],
      based_on: [],
      model_name: null,
      message: '対象となる在庫がありません。先に在庫を登録してください。',
    });
  }

  const items = lots.map((lot) => ({
    name: lot.displayName,
    expiresOn: lot.expiresOn,
    quantity: lot.quantity,
    unit: lot.unit,
  }));

  try {
    const { recipes, modelName } = await suggestRecipes(c.env, items);
    return c.json({
      recipes,
      based_on: lots.map((lot) => ({
        inventory_lot_id: lot.id,
        display_name: lot.displayName,
        expires_on: lot.expiresOn,
        quantity: lot.quantity,
        unit: lot.unit,
        days_until_expiry: daysUntil(lot.expiresOn, today),
      })),
      model_name: modelName,
    });
  } catch (e) {
    if (e instanceof GeminiError) {
      // レート制限は 429、それ以外は 502 として返す
      const status = e.code === 'rate_limited' ? 429 : 502;
      throw new ApiError(status, `gemini_${e.code}`, e.message);
    }
    throw e;
  }
});
