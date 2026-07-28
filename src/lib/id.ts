/**
 * ID生成。Workers ランタイムの crypto.randomUUID() を使う。
 * プレフィックス付きにしておくとログやデバッグで種別が分かりやすい。
 */
export function newId(prefix?: string): string {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}
