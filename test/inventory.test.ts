import { beforeEach, describe, expect, it } from 'vitest';
import { apiJson, createHousehold, dayFromToday, jsonBody } from './helpers';

const TOKEN = 'inv-user';

async function setup() {
  const householdId = await createHousehold(TOKEN, '在庫テスト家族');
  const loc = await apiJson(`/households/${householdId}/storage-locations`, {
    method: 'POST',
    body: jsonBody({ name: '冷蔵室', type: 'fridge' }),
    token: TOKEN,
  });
  return { householdId, locationId: loc.body.storage_location.id as string };
}

async function addLot(
  householdId: string,
  overrides: Record<string, unknown> = {},
) {
  const { status, body } = await apiJson(`/households/${householdId}/inventory`, {
    method: 'POST',
    body: jsonBody({
      display_name: 'にんじん',
      quantity: 3,
      unit: '本',
      expires_on: dayFromToday(5),
      ...overrides,
    }),
    token: TOKEN,
  });
  expect(status).toBe(201);
  return body.inventory_lot;
}

describe('inventory 登録', () => {
  let householdId: string;
  let locationId: string;

  beforeEach(async () => {
    ({ householdId, locationId } = await setup());
  });

  it('手動登録すると created イベントも記録される', async () => {
    const lot = await addLot(householdId, {
      location_id: locationId,
      purchased_on: dayFromToday(0),
      food_catalog_id: 'fc_ninjin',
    });

    expect(lot.status).toBe('active');
    expect(lot.source).toBe('manual');
    expect(lot.quantity).toBe(3);
    expect(lot.location_id).toBe(locationId);

    const events = await apiJson(`/inventory/${lot.id}/events`, { token: TOKEN });
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0].event_type).toBe('created');
    expect(events.body.events[0].quantity).toBe(3);
  });

  it('必須項目が欠けていると400', async () => {
    const { status, body } = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({ display_name: 'たまねぎ', quantity: 1 }),
      token: TOKEN,
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_request');
  });

  it('日付形式が不正だと400', async () => {
    const { status } = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'たまねぎ',
        quantity: 1,
        unit: '個',
        expires_on: '2026/08/01',
      }),
      token: TOKEN,
    });
    expect(status).toBe(400);
  });

  it('存在しない日付は400', async () => {
    const { status } = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'たまねぎ',
        quantity: 1,
        unit: '個',
        expires_on: '2026-02-30',
      }),
      token: TOKEN,
    });
    expect(status).toBe(400);
  });

  it('他householdのlocation_idは422', async () => {
    const otherHouseholdId = await createHousehold('other-user', '別の家');
    const otherLoc = await apiJson(
      `/households/${otherHouseholdId}/storage-locations`,
      {
        method: 'POST',
        body: jsonBody({ name: '冷蔵室', type: 'fridge' }),
        token: 'other-user',
      },
    );

    const { status } = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'たまねぎ',
        quantity: 1,
        unit: '個',
        expires_on: dayFromToday(3),
        location_id: otherLoc.body.storage_location.id,
      }),
      token: TOKEN,
    });
    expect(status).toBe(422);
  });
});

describe('inventory 一覧', () => {
  let householdId: string;
  let locationId: string;

  beforeEach(async () => {
    ({ householdId, locationId } = await setup());
  });

  it('期限が近い順にソートされる', async () => {
    await addLot(householdId, { display_name: '牛乳', expires_on: dayFromToday(10) });
    await addLot(householdId, { display_name: '豆腐', expires_on: dayFromToday(1) });
    await addLot(householdId, { display_name: '卵', expires_on: dayFromToday(6) });

    const { status, body } = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body.items.map((i: any) => i.display_name)).toEqual([
      '豆腐',
      '卵',
      '牛乳',
    ]);
    expect(body.items[0].days_until_expiry).toBe(1);
  });

  it('expiring_within_days で絞り込める', async () => {
    await addLot(householdId, { display_name: '牛乳', expires_on: dayFromToday(10) });
    await addLot(householdId, { display_name: '豆腐', expires_on: dayFromToday(2) });

    const { body } = await apiJson(
      `/households/${householdId}/inventory?expiring_within_days=3`,
      { token: TOKEN },
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].display_name).toBe('豆腐');
  });

  it('location_id で絞り込める', async () => {
    await addLot(householdId, { display_name: '牛乳', location_id: locationId });
    await addLot(householdId, { display_name: '米' });

    const { body } = await apiJson(
      `/households/${householdId}/inventory?location_id=${locationId}`,
      { token: TOKEN },
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].display_name).toBe('牛乳');
    expect(body.items[0].location_name).toBe('冷蔵室');
  });

  it('期限切れは is_expired が true', async () => {
    await addLot(householdId, { display_name: '古い牛乳', expires_on: dayFromToday(-2) });
    const { body } = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(body.items[0].is_expired).toBe(true);
    expect(body.items[0].days_until_expiry).toBe(-2);
  });

  it('カテゴリで絞り込める', async () => {
    await addLot(householdId, { display_name: 'にんじん', category: '野菜' });
    await addLot(householdId, { display_name: '豚肉', category: '肉' });
    await addLot(householdId, { display_name: '謎の食材' });

    const veg = await apiJson(
      `/households/${householdId}/inventory?category=野菜`,
      { token: TOKEN },
    );
    expect(veg.body.items).toHaveLength(1);
    expect(veg.body.items[0].display_name).toBe('にんじん');
    expect(veg.body.items[0].category).toBe('野菜');

    // 未分類はカテゴリ指定なしの一覧には出る
    const all = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(all.body.items).toHaveLength(3);
    expect(all.body.items.find((i: any) => i.display_name === '謎の食材').category)
      .toBeNull();
  });

  it('未定義のカテゴリは400', async () => {
    const { status } = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'おかし',
        quantity: 1,
        unit: '個',
        expires_on: dayFromToday(3),
        category: 'スナック',
      }),
      token: TOKEN,
    });
    expect(status).toBe(400);
  });

  it('メンバー以外は403', async () => {
    const { status } = await apiJson(`/households/${householdId}/inventory`, {
      token: 'nobody',
    });
    expect(status).toBe(403);
  });
});

describe('inventory 更新・消費・廃棄', () => {
  let householdId: string;
  let locationId: string;

  beforeEach(async () => {
    ({ householdId, locationId } = await setup());
  });

  it('PATCHで数量・保存場所を修正すると adjusted が記録される', async () => {
    const lot = await addLot(householdId);

    const { status, body } = await apiJson(`/inventory/${lot.id}`, {
      method: 'PATCH',
      body: jsonBody({ quantity: 2, location_id: locationId, note: '数え直し' }),
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body.inventory_lot.quantity).toBe(2);
    expect(body.inventory_lot.location_id).toBe(locationId);

    const events = await apiJson(`/inventory/${lot.id}/events`, { token: TOKEN });
    const types = events.body.events.map((e: any) => e.event_type);
    expect(types).toEqual(['created', 'adjusted']);
    expect(events.body.events[1].note).toBe('数え直し');
  });

  it('一部消費すると数量が減り active のまま', async () => {
    const lot = await addLot(householdId);

    const { status, body } = await apiJson(`/inventory/${lot.id}/consume`, {
      method: 'POST',
      body: jsonBody({ quantity: 1 }),
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body.inventory_lot.quantity).toBe(2);
    expect(body.inventory_lot.status).toBe('active');
  });

  it('全量消費すると status=consumed になる', async () => {
    const lot = await addLot(householdId);

    const { body } = await apiJson(`/inventory/${lot.id}/consume`, {
      method: 'POST',
      body: jsonBody({ quantity: 3 }),
      token: TOKEN,
    });
    expect(body.inventory_lot.quantity).toBe(0);
    expect(body.inventory_lot.status).toBe('consumed');
  });

  it('quantity省略なら残量すべてを消費する', async () => {
    const lot = await addLot(householdId);
    const { body } = await apiJson(`/inventory/${lot.id}/consume`, {
      method: 'POST',
      body: jsonBody({}),
      token: TOKEN,
    });
    expect(body.inventory_lot.status).toBe('consumed');
  });

  it('残量を超える消費は422', async () => {
    const lot = await addLot(householdId);
    const { status, body } = await apiJson(`/inventory/${lot.id}/consume`, {
      method: 'POST',
      body: jsonBody({ quantity: 99 }),
      token: TOKEN,
    });
    expect(status).toBe(422);
    expect(body.error.message).toContain('残量');
  });

  it('廃棄すると discarded が記録される', async () => {
    const lot = await addLot(householdId);
    const { body } = await apiJson(`/inventory/${lot.id}/discard`, {
      method: 'POST',
      body: jsonBody({ note: '傷んでいた' }),
      token: TOKEN,
    });
    expect(body.inventory_lot.status).toBe('discarded');

    const events = await apiJson(`/inventory/${lot.id}/events`, { token: TOKEN });
    expect(events.body.events.at(-1).event_type).toBe('discarded');
    expect(events.body.events.at(-1).quantity).toBe(3);
  });

  it('消費済みの在庫は再度操作できない', async () => {
    const lot = await addLot(householdId);
    await apiJson(`/inventory/${lot.id}/consume`, {
      method: 'POST',
      body: jsonBody({}),
      token: TOKEN,
    });

    const { status } = await apiJson(`/inventory/${lot.id}/discard`, {
      method: 'POST',
      body: jsonBody({}),
      token: TOKEN,
    });
    expect(status).toBe(409);
  });

  it('他人の在庫は403', async () => {
    const lot = await addLot(householdId);
    const { status } = await apiJson(`/inventory/${lot.id}`, { token: 'intruder' });
    expect(status).toBe(403);
  });
});

describe('開封', () => {
  let householdId: string;

  beforeEach(async () => {
    ({ householdId } = await setup());
  });

  it('開封するとカテゴリ別ルールで期限が短縮される', async () => {
    const lot = await addLot(householdId, {
      category: '野菜',
      expires_on: dayFromToday(20),
    });

    const { status, body } = await apiJson(`/inventory/${lot.id}/open`, {
      method: 'POST',
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body.inventory_lot.opened_at).toBe(dayFromToday(0));
    // 野菜は開封後3日ルール
    expect(body.inventory_lot.expires_on).toBe(dayFromToday(3));

    const events = await apiJson(`/inventory/${lot.id}/events`, { token: TOKEN });
    expect(events.body.events.at(-1).event_type).toBe('opened');
  });

  it('元の期限が開封後ルールより早ければ、期限は延びない', async () => {
    const lot = await addLot(householdId, {
      category: '調味料', // 開封後30日ルール
      expires_on: dayFromToday(2),
    });

    const { body } = await apiJson(`/inventory/${lot.id}/open`, {
      method: 'POST',
      token: TOKEN,
    });
    // 30日ルールより元の期限(2日後)の方が早いので、そのまま
    expect(body.inventory_lot.expires_on).toBe(dayFromToday(2));
  });

  it('カテゴリ未設定なら既定の3日ルールが適用される', async () => {
    const lot = await addLot(householdId, { expires_on: dayFromToday(20) });
    const { body } = await apiJson(`/inventory/${lot.id}/open`, {
      method: 'POST',
      token: TOKEN,
    });
    expect(body.inventory_lot.expires_on).toBe(dayFromToday(3));
  });

  it('既に開封済みのものは再度開封できない', async () => {
    const lot = await addLot(householdId, { expires_on: dayFromToday(20) });
    await apiJson(`/inventory/${lot.id}/open`, { method: 'POST', token: TOKEN });

    const { status } = await apiJson(`/inventory/${lot.id}/open`, {
      method: 'POST',
      token: TOKEN,
    });
    expect(status).toBe(409);
  });

  it('消費済みの在庫は開封できない', async () => {
    const lot = await addLot(householdId);
    await apiJson(`/inventory/${lot.id}/consume`, {
      method: 'POST',
      body: jsonBody({}),
      token: TOKEN,
    });

    const { status } = await apiJson(`/inventory/${lot.id}/open`, {
      method: 'POST',
      token: TOKEN,
    });
    expect(status).toBe(409);
  });

  it('在庫一覧にも開封状態(opened_at)が反映される', async () => {
    const lot = await addLot(householdId, { expires_on: dayFromToday(20) });
    await apiJson(`/inventory/${lot.id}/open`, { method: 'POST', token: TOKEN });

    const list = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(list.body.items[0].opened_at).toBe(dayFromToday(0));
  });
});

describe('events 履歴', () => {
  it('履歴一覧と集計を返す', async () => {
    const { householdId } = await setup();
    const lot1 = await addLot(householdId, { display_name: 'にんじん', quantity: 2 });
    const lot2 = await addLot(householdId, { display_name: 'キャベツ', quantity: 1 });

    await apiJson(`/inventory/${lot1.id}/consume`, {
      method: 'POST',
      body: jsonBody({ quantity: 2 }),
      token: TOKEN,
    });
    await apiJson(`/inventory/${lot2.id}/discard`, {
      method: 'POST',
      body: jsonBody({ quantity: 1 }),
      token: TOKEN,
    });

    const { status, body } = await apiJson(`/households/${householdId}/events`, {
      token: TOKEN,
    });
    expect(status).toBe(200);
    expect(body.events).toHaveLength(4);
    expect(body.summary.created.event_count).toBe(2);
    expect(body.summary.consumed.total_quantity).toBe(2);
    expect(body.summary.discarded.total_quantity).toBe(1);
    expect(body.loss_stats.consumption_rate).toBeCloseTo(0.667, 2);
    expect(body.events[0].display_name).toBeDefined();
  });

  it('from/to で期間を絞れる', async () => {
    const { householdId } = await setup();
    await addLot(householdId);

    const past = await apiJson(
      `/households/${householdId}/events?from=${dayFromToday(-30)}&to=${dayFromToday(-20)}`,
      { token: TOKEN },
    );
    expect(past.body.events).toHaveLength(0);

    const today = await apiJson(
      `/households/${householdId}/events?from=${dayFromToday(0)}&to=${dayFromToday(0)}`,
      { token: TOKEN },
    );
    expect(today.body.events.length).toBeGreaterThan(0);
  });

  it('from > to は400', async () => {
    const { householdId } = await setup();
    const { status } = await apiJson(
      `/households/${householdId}/events?from=${dayFromToday(1)}&to=${dayFromToday(0)}`,
      { token: TOKEN },
    );
    expect(status).toBe(400);
  });

  it('日別集計を返す', async () => {
    const { householdId } = await setup();
    await addLot(householdId);

    const { status, body } = await apiJson(
      `/households/${householdId}/events/daily`,
      { token: TOKEN },
    );
    expect(status).toBe(200);
    expect(body.daily[0].event_type).toBe('created');
    expect(body.daily[0].date).toBe(dayFromToday(0));
  });
});
