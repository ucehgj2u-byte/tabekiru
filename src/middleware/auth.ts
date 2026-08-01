import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { createDb, type Db } from '../db/client';
import { users, type User } from '../db/schema';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import { verifySessionToken } from '../services/authService';
import type { AppEnv } from '../types';

/**
 * マジックリンクログインで発行したセッションJWTによる認証。
 *
 *   Authorization: Bearer <session JWT>
 *
 * JWTは POST /auth/magic-link → GET /auth/verify で取得する（src/routes/auth.ts）。
 * ここでは署名・有効期限を検証し、payload.sub(=users.id) からユーザーを読み込む。
 */

/** D1バインディングからDrizzleクライアントを作って c.set('db') する。 */
export const dbMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('db', createDb(c.env.DB));
  await next();
};

export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw ApiError.unauthorized(
      'Authorization: Bearer <session token> ヘッダが必要です。POST /auth/magic-link でログインしてください',
    );
  }

  const db = c.get('db') ?? createDb(c.env.DB);
  const payload = await verifySessionToken(c.env, match[1].trim());

  const rows = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (rows.length === 0) {
    throw ApiError.unauthorized('セッションが無効です。再度ログインしてください');
  }

  c.set('db', db);
  c.set('user', rows[0]);
  await next();
};

/**
 * Authorizationヘッダがあれば認証し、無ければ素通りするミドルウェア。
 * 署名付きURLでも参照できる画像配信エンドポイント用。
 */
export const optionalAuthMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  if (!/^Bearer\s+.+$/i.test(header.trim())) {
    if (!c.get('db')) c.set('db', createDb(c.env.DB));
    await next();
    return;
  }
  await authMiddleware(c, next);
};

/** auth_user_id からユーザーを取得し、無ければ作成する。 */
export async function getOrCreateUser(
  db: Db,
  authUserId: string,
  profile: { email?: string; displayName?: string } = {},
): Promise<User> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.authUserId, authUserId))
    .limit(1);
  if (existing.length > 0) return existing[0];

  const email = profile.email?.trim() || `${authUserId}@example.local`;
  const displayName = profile.displayName?.trim() || authUserId;

  await db
    .insert(users)
    .values({
      id: newId('usr'),
      authUserId,
      email,
      displayName,
    })
    .onConflictDoNothing();

  const created = await db
    .select()
    .from(users)
    .where(eq(users.authUserId, authUserId))
    .limit(1);

  if (created.length === 0) {
    // email の UNIQUE 制約に別ユーザーが衝突した場合など
    throw ApiError.conflict(
      'ユーザーの作成に失敗しました。X-User-Email が他のユーザーと重複していないか確認してください',
    );
  }
  return created[0];
}
