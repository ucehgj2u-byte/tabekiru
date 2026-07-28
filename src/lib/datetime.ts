/**
 * 日付・日時ユーティリティ。
 * - 日付列(expires_on / purchased_on)は 'YYYY-MM-DD'
 * - 日時列(created_at など)は UTC の 'YYYY-MM-DD HH:MM:SS'（SQLite の datetime('now') と同形式）
 */

/** 現在時刻をUTCの 'YYYY-MM-DD HH:MM:SS' で返す。 */
export function nowUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** 現在日をUTCの 'YYYY-MM-DD' で返す。 */
export function todayUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' に日数を足した日付文字列を返す。 */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 今日から何日後が期限か（過去なら負の数）。 */
export function daysUntil(expiresOn: string, from: string = todayUtc()): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${expiresOn}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
