import type { FoodCategory } from './categories';
import { addDays } from './datetime';

/**
 * 開封後の日持ち目安（日数）。カテゴリ別の固定ルール。
 * AIには問い合わせず、その場で即座に計算する。
 * 未開封の賞味期限より安全側（短め）に倒した目安値。
 */
const OPENED_SHELF_LIFE_DAYS: Record<FoodCategory, number> = {
  野菜: 3,
  果物: 3,
  肉: 1,
  魚介: 1,
  乳製品: 3,
  卵: 7,
  大豆製品: 2,
  主食: 3,
  惣菜: 1,
  調味料: 30,
  飲料: 3,
  その他: 3,
};

/** カテゴリ未設定（null）の場合に使う既定値。 */
const DEFAULT_OPENED_SHELF_LIFE_DAYS = 3;

/** カテゴリから開封後の日持ち日数を返す。 */
export function openedShelfLifeDays(category: string | null): number {
  if (category && category in OPENED_SHELF_LIFE_DAYS) {
    return OPENED_SHELF_LIFE_DAYS[category as FoodCategory];
  }
  return DEFAULT_OPENED_SHELF_LIFE_DAYS;
}

/**
 * 開封時の新しい消費期限を計算する。
 * 「開封日 + カテゴリ別日数」と「元々の消費期限」の早い方を採用する
 * （開封したことで元の期限より延びることは無いようにする）。
 */
export function resolveOpenedExpiry(
  category: string | null,
  openedOn: string,
  currentExpiresOn: string,
): string {
  const candidate = addDays(openedOn, openedShelfLifeDays(category));
  return candidate < currentExpiresOn ? candidate : currentExpiresOn;
}
