import { describe, expect, it } from 'vitest';
import { openedShelfLifeDays, resolveOpenedExpiry } from '../src/lib/openedShelfLife';

describe('openedShelfLifeDays', () => {
  it('カテゴリごとの日数を返す', () => {
    expect(openedShelfLifeDays('肉')).toBe(1);
    expect(openedShelfLifeDays('調味料')).toBe(30);
    expect(openedShelfLifeDays('野菜')).toBe(3);
  });

  it('未知のカテゴリ・nullは既定の3日', () => {
    expect(openedShelfLifeDays(null)).toBe(3);
    expect(openedShelfLifeDays('スナック菓子')).toBe(3);
  });
});

describe('resolveOpenedExpiry', () => {
  it('開封日+カテゴリ日数が元の期限より早ければそちらを採用する', () => {
    // 野菜(3日)、元の期限は20日後 → 開封後ルールの方が早い
    expect(resolveOpenedExpiry('野菜', '2026-08-01', '2026-08-21')).toBe('2026-08-04');
  });

  it('元の期限の方が早ければ、期限は延びない', () => {
    // 調味料(30日)だが、元の期限が2日後 → 元の期限のまま
    expect(resolveOpenedExpiry('調味料', '2026-08-01', '2026-08-03')).toBe('2026-08-03');
  });

  it('ちょうど同じ日になる場合は元の期限を返す', () => {
    expect(resolveOpenedExpiry('肉', '2026-08-01', '2026-08-02')).toBe('2026-08-02');
  });
});
