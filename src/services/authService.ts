import { and, eq, isNull } from 'drizzle-orm';
import { sign, verify } from 'hono/jwt';
import type { Db } from '../db/client';
import { magicLinkTokens, users, type User } from '../db/schema';
import { nowUtc } from '../lib/datetime';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import { sendEmail } from '../lib/resendClient';
import type { Bindings } from '../types';

/**
 * マジックリンクログイン。
 * 1. POST /auth/magic-link でメールアドレス宛にワンタイムトークン付きのリンクを送る
 * 2. GET /auth/verify?token=... でトークンを検証し、セッションJWTを発行する
 * 3. 以降は Authorization: Bearer <JWT> でAPIを呼ぶ（authMiddleware参照）
 *
 * 生のワンタイムトークンはDBに保存しない（SHA-256ハッシュのみ保存）。
 */

const MAGIC_LINK_TTL_MINUTES = 15;
const SESSION_TTL_DAYS = 30;
const JWT_ALG = 'HS256';

function authJwtSecret(env: Pick<Bindings, 'AUTH_JWT_SECRET'>): string {
  return env.AUTH_JWT_SECRET?.trim() || 'dev-only-jwt-secret-change-in-production';
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** 32バイトのランダムトークンを16進文字列で生成する。 */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * メールアドレス宛にログイン用リンクを送る。
 * アカウントの有無を外部に漏らさないよう、常に同じ結果（例外を投げない）にする。
 */
export async function requestMagicLink(
  db: Db,
  env: Pick<Bindings, 'RESEND_API_KEY' | 'NOTIFY_FROM_EMAIL'>,
  rawEmail: string,
  origin: string,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const rawToken = randomToken();
  const tokenHash = await sha256Hex(rawToken);

  await db.insert(magicLinkTokens).values({
    id: newId('mlt'),
    email,
    tokenHash,
    expiresAt: addMinutes(nowUtc(), MAGIC_LINK_TTL_MINUTES),
  });

  const verifyUrl = `${origin}/auth/verify?token=${rawToken}`;
  await sendEmail({
    env,
    to: [email],
    subject: '【mogu】ログイン用リンク',
    html: `<p>以下のリンクをクリックしてログインしてください（${MAGIC_LINK_TTL_MINUTES}分間有効・1回のみ使用できます）。</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>心当たりが無い場合はこのメールを無視してください。</p>`,
  });
}

/**
 * マジックリンクのトークンを検証し、使用済みにした上でユーザーを返す
 * （未登録のメールアドレスなら新規作成する＝これがそのままサインアップになる）。
 * 無効・期限切れ・使用済みのトークンは 401。
 */
export async function consumeMagicLink(db: Db, rawToken: string): Promise<User> {
  if (!rawToken) {
    throw ApiError.unauthorized('ログインリンクが無効です');
  }
  const tokenHash = await sha256Hex(rawToken);
  const now = nowUtc();

  const rows = await db
    .select()
    .from(magicLinkTokens)
    .where(and(eq(magicLinkTokens.tokenHash, tokenHash), isNull(magicLinkTokens.consumedAt)))
    .limit(1);

  const record = rows[0];
  if (!record || record.expiresAt < now) {
    throw ApiError.unauthorized('ログインリンクが無効か、期限切れです。もう一度リンクを送ってください');
  }

  await db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(eq(magicLinkTokens.id, record.id));

  return await findOrCreateUserByEmail(db, record.email);
}

/** メールアドレスからユーザーを取得し、無ければ作成する（マジックリンクの検証で使う）。 */
export async function findOrCreateUserByEmail(db: Db, email: string): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) return existing[0];

  await db
    .insert(users)
    .values({
      id: newId('usr'),
      authUserId: newId('authuser'),
      email,
      displayName: email.split('@')[0],
    })
    .onConflictDoNothing();

  const created = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (created.length === 0) {
    throw ApiError.internal('ユーザーの作成に失敗しました');
  }
  return created[0];
}

export type SessionPayload = { sub: string; email: string; exp: number; iat: number };

/** ログイン済みユーザーのセッションJWTを発行する（既定30日有効）。 */
export async function signSessionToken(
  env: Pick<Bindings, 'AUTH_JWT_SECRET'>,
  user: User,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_DAYS * 24 * 60 * 60,
  };
  return await sign(payload, authJwtSecret(env), JWT_ALG);
}

/** セッションJWTを検証し、ペイロードを返す。無効・期限切れは 401。 */
export async function verifySessionToken(
  env: Pick<Bindings, 'AUTH_JWT_SECRET'>,
  token: string,
): Promise<SessionPayload> {
  try {
    return (await verify(token, authJwtSecret(env), JWT_ALG)) as SessionPayload;
  } catch {
    throw ApiError.unauthorized('セッションが無効か期限切れです。再度ログインしてください');
  }
}

function addMinutes(datetimeUtc: string, minutes: number): string {
  const d = new Date(`${datetimeUtc.replace(' ', 'T')}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
