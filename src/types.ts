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
};

/** ミドルウェアが c.set() する値。 */
export type Variables = {
  db: Db;
  user: User;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
