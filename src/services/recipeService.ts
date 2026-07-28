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

export type Recipe = {
  title: string;
  used_ingredients: string[];
  steps: string[];
};

const RESPONSE_SCHEMA: GeminiSchema = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      used_ingredients: { type: 'ARRAY', items: { type: 'STRING' } },
      steps: { type: 'ARRAY', items: { type: 'STRING' } },
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
    '以下は家庭の冷蔵庫にある、期限が近い順の食材リストです。',
    'これらをできるだけ多く使い、食品ロスを減らせる家庭料理レシピを3つ提案してください。',
    '調味料など一般的な家庭にあるものは追加で使って構いませんが、used_ingredients には',
    'リスト内の食材のうち実際に使うものを日本語の名称そのままで入れてください。',
    'steps は家庭で作れる具体的な手順を3〜8個程度で書いてください。',
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
