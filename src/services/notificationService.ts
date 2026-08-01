import { and, asc, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client';
import { householdMembers, households, inventoryLots, users } from '../db/schema';
import { addDays, daysUntil, todayUtc } from '../lib/datetime';
import { sendEmail } from '../lib/resendClient';
import type { Bindings } from '../types';

/** 環境変数未指定時に「期限が近い」とみなす日数。 */
export const DEFAULT_EXPIRING_WITHIN_DAYS = 3;

/** 環境変数から通知対象の日数しきい値を解決する。 */
export function resolveWithinDays(
  env: Pick<Bindings, 'NOTIFY_EXPIRING_WITHIN_DAYS'>,
): number {
  const raw = env.NOTIFY_EXPIRING_WITHIN_DAYS?.trim();
  if (!raw) return DEFAULT_EXPIRING_WITHIN_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_EXPIRING_WITHIN_DAYS;
}

/**
 * 「期限が近い食材をメールで通知」機能。
 * - 対象: householdごとに active な在庫のうち expires_on が (今日 + within_days) 以内のもの
 * - 宛先: そのhouseholdの active メンバー全員
 * - 送信: Resend API（src/lib/resendClient.ts）
 */

export type ExpiringItem = {
  id: string;
  display_name: string;
  quantity: number;
  unit: string;
  expires_on: string;
  days_until_expiry: number;
};

export type HouseholdDigest = {
  household_id: string;
  household_name: string;
  recipients: string[];
  items: ExpiringItem[];
};

/**
 * 指定household内の、期限が近い(または既に切れている) active な在庫をまとめる。
 * 対象が無い、または宛先(activeメンバー)が居ない場合は null を返す。
 */
export async function buildHouseholdDigest(
  db: Db,
  householdId: string,
  withinDays: number,
): Promise<HouseholdDigest | null> {
  const householdRows = await db
    .select({ id: households.id, name: households.name })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  if (householdRows.length === 0) return null;

  const today = todayUtc();
  const threshold = addDays(today, withinDays);

  const lots = await db
    .select()
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.householdId, householdId),
        eq(inventoryLots.status, 'active'),
        lte(inventoryLots.expiresOn, threshold),
      ),
    )
    .orderBy(asc(inventoryLots.expiresOn));
  if (lots.length === 0) return null;

  const memberRows = await db
    .select({ email: users.email })
    .from(householdMembers)
    .innerJoin(users, eq(householdMembers.userId, users.id))
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        eq(householdMembers.status, 'active'),
      ),
    );
  const recipients = memberRows.map((m) => m.email);
  if (recipients.length === 0) return null;

  return {
    household_id: householdId,
    household_name: householdRows[0].name,
    recipients,
    items: lots.map((lot) => ({
      id: lot.id,
      display_name: lot.displayName,
      quantity: lot.quantity,
      unit: lot.unit,
      expires_on: lot.expiresOn,
      days_until_expiry: daysUntil(lot.expiresOn, today),
    })),
  };
}

/** active な在庫を持つhouseholdのID一覧（cronで全件を回すため）。 */
export async function listHouseholdIdsWithActiveInventory(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ householdId: inventoryLots.householdId })
    .from(inventoryLots)
    .where(eq(inventoryLots.status, 'active'));
  return rows.map((r) => r.householdId);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function remainingLabel(daysUntilExpiry: number): string {
  if (daysUntilExpiry < 0) return `期限切れ（${Math.abs(daysUntilExpiry)}日経過）`;
  if (daysUntilExpiry === 0) return '本日が期限';
  return `あと${daysUntilExpiry}日`;
}

function renderDigestHtml(digest: HouseholdDigest): string {
  const rows = digest.items
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.display_name)}</td>
        <td>${item.quantity}${escapeHtml(item.unit)}</td>
        <td>${escapeHtml(item.expires_on)}</td>
        <td>${escapeHtml(remainingLabel(item.days_until_expiry))}</td>
      </tr>`,
    )
    .join('\n');

  return `<div>
    <p>${escapeHtml(digest.household_name)} の冷蔵庫で、消費期限が近い食材が ${digest.items.length}件 あります。</p>
    <table cellpadding="6" style="border-collapse:collapse;border:1px solid #ddd;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th align="left">食材</th>
          <th align="left">数量</th>
          <th align="left">消費期限</th>
          <th align="left">残り</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export type SendDigestResult = {
  email_id: string;
  recipients: string[];
  item_count: number;
};

/** digestをメール本文に整形してResendで送る。 */
export async function sendHouseholdDigestEmail(
  env: Pick<Bindings, 'RESEND_API_KEY' | 'NOTIFY_FROM_EMAIL'>,
  digest: HouseholdDigest,
): Promise<SendDigestResult> {
  const result = await sendEmail({
    env,
    to: digest.recipients,
    subject: `【mogu】${digest.household_name}: 消費期限が近い食材が${digest.items.length}件あります`,
    html: renderDigestHtml(digest),
  });
  return {
    email_id: result.id,
    recipients: digest.recipients,
    item_count: digest.items.length,
  };
}

export type RunAllResult = {
  checked_households: number;
  sent: number;
  skipped: number;
  failed: Array<{ household_id: string; message: string }>;
};

/**
 * 全household分をまとめて処理する（cronから毎日呼び出す）。
 * 1householdの送信失敗が他householdの処理を止めないよう、個別にtry/catchする。
 */
export async function runExpiryNotifications(
  db: Db,
  env: Pick<Bindings, 'RESEND_API_KEY' | 'NOTIFY_FROM_EMAIL' | 'NOTIFY_EXPIRING_WITHIN_DAYS'>,
): Promise<RunAllResult> {
  const withinDays = resolveWithinDays(env);
  const householdIds = await listHouseholdIdsWithActiveInventory(db);
  const result: RunAllResult = {
    checked_households: householdIds.length,
    sent: 0,
    skipped: 0,
    failed: [],
  };

  for (const householdId of householdIds) {
    try {
      const digest = await buildHouseholdDigest(db, householdId, withinDays);
      if (!digest) {
        result.skipped++;
        continue;
      }
      await sendHouseholdDigestEmail(env, digest);
      result.sent++;
    } catch (e) {
      result.failed.push({ household_id: householdId, message: (e as Error).message });
    }
  }

  return result;
}
