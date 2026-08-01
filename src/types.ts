import type { Db } from './db/client';
import type { User } from './db/schema';

/** wrangler.toml / secret で定義したバインディング。 */
export type Bindings = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  /** `wrangler secret put GEMINI_API_KEY`（ローカルは .dev.vars）で設定 */
  GEMINI_API_KEY: string;
  /** 例: 'gemini-3-flash-preview' / 'gemini-3.1-flash-lite' */
  GEMINI_MODEL?: string;
  /** 画像取得URLの署名鍵。本番は `wrangler secret put PHOTO_URL_SECRET` で設定する。 */
  PHOTO_URL_SECRET?: string;
  /** `wrangler secret put RESEND_API_KEY`（ローカルは .dev.vars）で設定。期限通知メールの送信に使う */
  RESEND_API_KEY: string;
  /** セッションJWTの署名鍵。本番は `wrangler secret put AUTH_JWT_SECRET` で上書きすること。 */
  AUTH_JWT_SECRET?: string;
  /** 通知メールの送信元。未指定なら resendClient の既定値（onboarding@resend.dev）を使う */
  NOTIFY_FROM_EMAIL?: string;
  /** 「期限が近い」とみなす日数。未指定なら既定の3日 */
  NOTIFY_EXPIRING_WITHIN_DAYS?: string;
};

/** ミドルウェアが c.set() する値。 */
export type Variables = {
  db: Db;
  user: User;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
