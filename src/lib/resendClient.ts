import type { Bindings } from '../types';

/**
 * Resend API 呼び出しの共通ラッパー。
 * notificationService はこのモジュール経由で呼ぶ。SDKは使わず REST を fetch で叩く。
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * 既定の送信元アドレス。
 * Resend は自ドメイン検証なしでもこのアドレスからの送信をサポートしているため、
 * ハッカソンMVPではこれを既定にしている。本番は環境変数 NOTIFY_FROM_EMAIL で
 * 検証済み自ドメインのアドレスに切り替える。
 */
export const DEFAULT_FROM_EMAIL = 'onboarding@resend.dev';

export type ResendErrorCode = 'missing_api_key' | 'api_error' | 'network_error';

export class ResendError extends Error {
  readonly code: ResendErrorCode;
  readonly httpStatus?: number;

  constructor(code: ResendErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'ResendError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 環境変数から送信元アドレスを解決する。 */
export function resolveFromEmail(env: Pick<Bindings, 'NOTIFY_FROM_EMAIL'>): string {
  return env.NOTIFY_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;
}

export type SendEmailOptions = {
  env: Pick<Bindings, 'RESEND_API_KEY' | 'NOTIFY_FROM_EMAIL'>;
  to: string[];
  subject: string;
  html: string;
};

export type SendEmailResult = { id: string };

/** Resend の /emails エンドポイントでメールを1通送る。 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { env, to, subject, html } = options;

  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new ResendError(
      'missing_api_key',
      'RESEND_API_KEY が設定されていません。`wrangler secret put RESEND_API_KEY`（ローカルは .dev.vars）で設定してください',
    );
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from: resolveFromEmail(env), to, subject, html }),
    });
  } catch (e) {
    throw new ResendError(
      'network_error',
      `Resend APIへの接続に失敗しました: ${(e as Error).message}`,
    );
  }

  if (!response.ok) {
    const detail = await safeText(response);
    throw new ResendError(
      'api_error',
      `Resend APIがエラーを返しました (HTTP ${response.status}): ${detail}`,
      response.status,
    );
  }

  const payload = (await response.json().catch(() => null)) as { id?: string } | null;
  if (!payload?.id) {
    throw new ResendError('api_error', 'Resend APIのレスポンスにメールIDが含まれていませんでした');
  }
  return { id: payload.id };
}

async function safeText(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 500);
  } catch {
    return '(レスポンス本文を取得できませんでした)';
  }
}
