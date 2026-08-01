import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runExpiryNotifications } from '../src/services/notificationService';
import { apiJson, createHousehold, dayFromToday, jsonBody } from './helpers';

const TOKEN = 'notify-user';
const RESEND_ORIGIN = 'https://api.resend.com';

/** Resendへ送られたリクエストを記録する。 */
let resendCalls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  resendCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** global fetch を差し替えて Resend API をモックする。 */
function mockResend(status = 200, id = 'email_test_id') {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(RESEND_ORIGIN)) {
      throw new Error(`想定外の外部リクエスト: ${url}`);
    }
    const body = init?.body ? JSON.parse(init.body as string) : null;
    resendCalls.push({ url, body });

    return new Response(
      JSON.stringify(status === 200 ? { id } : { message: 'error' }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  });
}

async function addLot(householdId: string, expiresOn: string, displayName = 'にんじん') {
  const { status, body } = await apiJson(`/households/${householdId}/inventory`, {
    method: 'POST',
    body: jsonBody({
      display_name: displayName,
      quantity: 2,
      unit: '本',
      expires_on: expiresOn,
    }),
    token: TOKEN,
  });
  expect(status).toBe(201);
  return body.inventory_lot;
}

describe('POST /households/:id/notifications/expiring-check', () => {
  it('期限が近い在庫があればメンバー全員にメールを送る', async () => {
    mockResend();
    const householdId = await createHousehold(TOKEN, '通知テスト家族');
    await addLot(householdId, dayFromToday(1));
    await addLot(householdId, dayFromToday(10)); // 対象外(既定3日以内ではない)

    const { status, body } = await apiJson(
      `/households/${householdId}/notifications/expiring-check`,
      { method: 'POST', token: TOKEN },
    );

    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].display_name).toBe('にんじん');
    expect(body.recipients).toContain(`${TOKEN}@example.local`);

    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].body.to).toEqual(body.recipients);
    expect(resendCalls[0].body.subject).toContain('通知テスト家族');
    expect(resendCalls[0].body.html).toContain('にんじん');
  });

  it('期限が近い在庫が無ければメールを送らない', async () => {
    mockResend();
    const householdId = await createHousehold(TOKEN, '通知なし家族');
    await addLot(householdId, dayFromToday(30));

    const { status, body } = await apiJson(
      `/households/${householdId}/notifications/expiring-check`,
      { method: 'POST', token: TOKEN },
    );

    expect(status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.reason).toBe('no_expiring_items');
    expect(resendCalls).toHaveLength(0);
  });

  it('within_days で対象日数を変えられる', async () => {
    mockResend();
    const householdId = await createHousehold(TOKEN, '日数指定家族');
    await addLot(householdId, dayFromToday(10));

    const { status, body } = await apiJson(
      `/households/${householdId}/notifications/expiring-check?within_days=14`,
      { method: 'POST', token: TOKEN },
    );

    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.items).toHaveLength(1);
  });

  it('householdのメンバーでなければ403', async () => {
    const householdId = await createHousehold(TOKEN, '他人の家族');

    const { status } = await apiJson(
      `/households/${householdId}/notifications/expiring-check`,
      { method: 'POST', token: 'someone-else' },
    );

    expect(status).toBe(403);
  });
});

describe('runExpiryNotifications（cron本体）', () => {
  // D1のテストストレージはファイル内のテスト間で共有されるため、
  // 「件数の完全一致」ではなく「このテストで作ったhouseholdが正しく扱われたか」を検証する。
  it('複数householdをまとめて処理し、対象があるものだけ送信する', async () => {
    mockResend();
    const withItems = await createHousehold(TOKEN, '対象あり家族');
    await addLot(withItems, dayFromToday(1), 'キャベツ');
    const withoutItems = await createHousehold(TOKEN, '対象なし家族');
    await addLot(withoutItems, dayFromToday(60));

    const { env } = await import('cloudflare:test');
    const db = createDb(env.DB);
    const result = await runExpiryNotifications(db, env);

    expect(result.failed).toEqual([]);
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const subjects = resendCalls.map((call) => call.body.subject as string);
    expect(subjects.some((s) => s.includes('対象あり家族'))).toBe(true);
    expect(subjects.some((s) => s.includes('対象なし家族'))).toBe(false);
  });
});
