import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { createDb, type Db } from '../db/client';
import { users, type User } from '../db/schema';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import type { AppEnv } from '../types';

/**
 * ハッカソンMVP向けの簡易認証。
 *
 *   Authorization: Bearer <token>
 *
 * の <token> をそのまま users.auth_user_id として扱い、
 * 未登録なら自動でユーザーを作成する（本番はOAuth/JWT検証に差し替える）。
 *
 * 初回作成時のみ、以下のヘッダでプロフィールを指定できる:
 *   X-User-Email        (省略時は <token>@example.local)
 *   X-User-Display-Name (省略時は <token>)
 */

const TOKEN_PATTERN = /^[A-Za-z0-9._:@-]{3,128}$/;

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
      'Authorization: Bearer <token> ヘッダが必要です',
    );
  }

  const token = match[1].trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw ApiError.unauthorized('トークンの形式が不正です');
  }

  const db = c.get('db') ?? createDb(c.env.DB);
  const user = await getOrCreateUser(db, token, {
    email: c.req.header('X-User-Email'),
    displayName: c.req.header('X-User-Display-Name'),
  });

  c.set('db', db);
  c.set('user', user);
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
