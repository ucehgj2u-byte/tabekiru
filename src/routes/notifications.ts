import { Hono } from 'hono';
import { assertHouseholdAccess } from '../lib/access';
import { ApiError } from '../lib/errors';
import { ResendError } from '../lib/resendClient';
import { expiringCheckQuerySchema, parseQuery } from '../lib/validators';
import {
  buildHouseholdDigest,
  sendHouseholdDigestEmail,
} from '../services/notificationService';
import type { AppEnv } from '../types';

/** /households にマウント */
export const householdNotificationsRoute = new Hono<AppEnv>();

/**
 * POST /households/:id/notifications/expiring-check
 *   ?within_days=3（既定3日）
 *
 * このhouseholdの期限が近い在庫を集計し、あれば active メンバー全員にメールを送る。
 * 本番は scheduled（cron）で毎日全household分を自動実行するが（src/index.ts）、
 * 動作確認・デモ用に単一household分だけ即時実行できるようにしている。
 */
householdNotificationsRoute.post('/:id/notifications/expiring-check', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const { within_days } = parseQuery(c, expiringCheckQuerySchema);
  const digest = await buildHouseholdDigest(db, householdId, within_days);
  if (!digest) {
    return c.json({ sent: false, reason: 'no_expiring_items', items: [] });
  }

  try {
    const result = await sendHouseholdDigestEmail(c.env, digest);
    return c.json({
      sent: true,
      recipients: result.recipients,
      email_id: result.email_id,
      items: digest.items,
    });
  } catch (e) {
    if (e instanceof ResendError) {
      const status = e.code === 'missing_api_key' ? 500 : 502;
      throw new ApiError(status, `resend_${e.code}`, e.message);
    }
    throw e;
  }
});
