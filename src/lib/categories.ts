/**
 * 食材カテゴリ。
 * 表記ゆれで集計・絞り込みが壊れないよう、この一覧に固定する。
 * AIにもこの中から選ばせ、外れた値は「その他」に寄せる。
 */
export const FOOD_CATEGORIES = [
  '野菜',
  '果物',
  '肉',
  '魚介',
  '乳製品',
  '卵',
  '大豆製品',
  '主食',
  '惣菜',
  '調味料',
  '飲料',
  'その他',
] as const;

export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

/** AIやクライアントから来た文字列をカテゴリに正規化する。判別できなければ null。 */
export function normalizeCategory(value: unknown): FoodCategory | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if ((FOOD_CATEGORIES as readonly string[]).includes(trimmed)) {
    return trimmed as FoodCategory;
  }

  // 表記ゆれの吸収（AIが別の言い方をした場合）
  const aliases: Record<string, FoodCategory> = {
    野菜類: '野菜',
    青果: '野菜',
    きのこ: '野菜',
    果実: '果物',
    フルーツ: '果物',
    精肉: '肉',
    肉類: '肉',
    鮮魚: '魚介',
    魚: '魚介',
    魚類: '魚介',
    海産物: '魚介',
    乳製品類: '乳製品',
    牛乳: '乳製品',
    たまご: '卵',
    豆腐: '大豆製品',
    豆類: '大豆製品',
    穀物: '主食',
    パン: '主食',
    麺: '主食',
    米: '主食',
    冷凍食品: '惣菜',
    加工食品: '惣菜',
    調味料類: '調味料',
    飲み物: '飲料',
  };
  return aliases[trimmed] ?? 'その他';
}
