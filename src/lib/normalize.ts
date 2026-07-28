/**
 * food_catalog.normalized_name の生成規則。
 * NFKC正規化（全角英数字→半角、半角カナ→全角カナ）+ 小文字化 + 空白除去。
 * 検索側でも同じ関数を通してから比較する。
 */
export function normalizeName(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim();
}
