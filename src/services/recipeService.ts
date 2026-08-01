import { GeminiError, generateJson, type GeminiSchema } from '../lib/geminiClient';
import type { Bindings } from '../types';

/**
 * Gemini API を使ったレシピ提案。
 * 期限が近い順の食材リストをプロンプトに埋め込んでテキストのみで問い合わせる。
 */

export type RecipeInputItem = {
  name: string;
  expiresOn: string;
  quantity?: number;
  unit?: string;
};

/** used_ingredients のうち1品について、実際に使う分量の目安。 */
export type IngredientAmount = {
  name: string;
  quantity: number;
  unit: string;
};

export type Recipe = {
  title: string;
  used_ingredients: string[];
  steps: string[];
  /** リストに無い、買い足すとよい食材（調味料等の一般的な常備品は含めない） */
  missing_ingredients: string[];
  /**
   * used_ingredients の各食材について実際に使う分量の目安。
   * 「これを作った」時の在庫消費（自動消費）で、確認ダイアログの初期値として使う。
   * AIの目安なので誤差はあり得る前提で、UI側で数量を編集できるようにする。
   */
  ingredient_amounts: IngredientAmount[];
};

const RESPONSE_SCHEMA: GeminiSchema = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      used_ingredients: { type: 'ARRAY', items: { type: 'STRING' } },
      steps: { type: 'ARRAY', items: { type: 'STRING' } },
      missing_ingredients: { type: 'ARRAY', items: { type: 'STRING' } },
      ingredient_amounts: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            quantity: { type: 'NUMBER' },
            unit: { type: 'STRING' },
          },
          required: ['name', 'quantity', 'unit'],
        },
      },
    },
    required: ['title', 'used_ingredients', 'steps'],
  },
};

/** 「にんじん(期限2026-08-02、2本)、牛乳(期限2026-08-03)」のように整形する。 */
export function formatIngredientList(items: RecipeInputItem[]): string {
  return items
    .map((item) => {
      const amount =
        item.quantity !== undefined && item.unit
          ? `、${item.quantity}${item.unit}`
          : '';
      return `${item.name}(期限${item.expiresOn}${amount})`;
    })
    .join('、');
}

function buildPrompt(items: RecipeInputItem[]): string {
  return [
    '以下は家庭の冷蔵庫にある食材リストです（期限が近い順）。',
    '美味しくて満足度の高い家庭料理レシピを3つ提案してください。',
    '',
    '最優先は美味しさと作りやすさです。このリストの食材を無理にすべて使う必要はありません。',
    'リストに無い食材を主役にしたレシピを含めても構いません。',
    'ただし、リストの中に活かせる食材があれば積極的に使い、食品ロスの削減にもつながる',
    '提案を心がけてください（「美味しいが在庫を全く使わない」提案ばかりにはしないこと）。',
    '調味料など一般的な家庭にあるものは自由に使って構いません。',
    '',
    'used_ingredients には、実際にそのレシピで使うリスト内の食材だけを日本語の名称そのままで',
    '入れてください。リストの食材を使っていないレシピの場合は空配列にしてください。',
    'steps は家庭で作れる具体的な手順を3〜8個程度で書いてください。',
    'missing_ingredients には、リストに無いが買い足すとより美味しく/完成度高く作れる食材を',
    '2〜4個挙げてください（塩・こしょう・油・醤油などどの家庭にもある調味料は含めないこと）。',
    '買い足す必要が無いレシピの場合は空配列にしてください。',
    'ingredient_amounts には、used_ingredients に入れた食材それぞれについて、',
    'このレシピで実際に使う分量の目安を { name, quantity, unit } で入れてください。',
    'name は used_ingredients と同じ表記にし、unit は食材リストに書かれている単位に',
    'できるだけ合わせてください（例: 食材リストで「2本」なら本単位で答える）。',
    '在庫をすべて使い切るとは限らないので、レシピとして自然な分量を答えてください',
    '（例: キャベツ1玉のうち1/4だけ使うなら quantity は 0.25、unit は 玉）。',
    '',
    `食材リスト: ${formatIngredientList(items)}`,
  ].join('\n');
}

/**
 * 食材リストからレシピを3つ提案する。
 * 失敗時は GeminiError を投げる（ルート側で適切なHTTPステータスに変換する）。
 */
export async function suggestRecipes(
  env: Pick<Bindings, 'GEMINI_API_KEY' | 'GEMINI_MODEL'>,
  items: RecipeInputItem[],
): Promise<{ recipes: Recipe[]; modelName: string }> {
  if (items.length === 0) {
    return { recipes: [], modelName: '' };
  }

  const { data, modelName } = await generateJson<unknown>({
    env,
    parts: [{ text: buildPrompt(items) }],
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0.7,
  });

  return { recipes: sanitizeRecipes(data), modelName };
}

function sanitizeRecipes(data: unknown): Recipe[] {
  if (!Array.isArray(data)) {
    throw new GeminiError(
      'invalid_json',
      'Gemini APIのレスポンスが配列ではありませんでした',
    );
  }

  const recipes: Recipe[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) continue;

    recipes.push({
      title,
      used_ingredients: toStringArray(item.used_ingredients),
      steps: toStringArray(item.steps),
      missing_ingredients: toStringArray(item.missing_ingredients),
      ingredient_amounts: toIngredientAmounts(item.ingredient_amounts),
    });
  }
  return recipes;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toIngredientAmounts(value: unknown): IngredientAmount[] {
  if (!Array.isArray(value)) return [];
  const result: IngredientAmount[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const quantity = typeof item.quantity === 'number' ? item.quantity : NaN;
    const unit = typeof item.unit === 'string' ? item.unit.trim() : '';
    if (!name || !unit || !Number.isFinite(quantity) || quantity <= 0) continue;
    result.push({ name, quantity, unit });
  }
  return result;
}
