import { ApiError } from '../lib/errors';

/**
 * R2への画像保存・取得。
 *
 * 注意: Workers の R2 バインディングには presign API が無いため、
 * 「署名付きURL」は本APIの短期署名トークン付きURL
 *   GET /photos/:id/content?token=...
 * で代替する（トークンはHMAC-SHA256 + 有効期限付き）。
 * 認証ヘッダを付けられない <img src> からも参照できる。
 */

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** 10MB。Workers のリクエストサイズ制限も踏まえた上限。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function isAllowedImageMime(mime: string): boolean {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * MIMEタイプを決める。
 * ブラウザやOSによっては file.type が空、または application/octet-stream に
 * なることがあるため、その場合はファイル名の拡張子から補う。
 */
export function resolveMimeType(file: File): string {
  const declared = (file.type || '').toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;

  const ext = file.name?.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? declared;
}

export function buildPhotoKey(
  householdId: string,
  photoId: string,
  mimeType: string,
): string {
  const ext = EXTENSION_BY_MIME[mimeType] ?? 'bin';
  return `households/${householdId}/photos/${photoId}.${ext}`;
}

export async function putPhoto(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  await bucket.put(key, body, {
    httpMetadata: { contentType: mimeType },
  });
}

/** R2から画像バイナリを取得する。存在しなければ 404 を投げる。 */
export async function getPhotoBytes(
  bucket: R2Bucket,
  key: string,
): Promise<ArrayBuffer> {
  const object = await bucket.get(key);
  if (!object) {
    throw ApiError.notFound(`画像がR2に存在しません (key: ${key})`);
  }
  return await object.arrayBuffer();
}

/** ストリームのまま返したい場合（画像配信エンドポイント用）。 */
export async function getPhotoObject(
  bucket: R2Bucket,
  key: string,
): Promise<R2ObjectBody> {
  const object = await bucket.get(key);
  if (!object) {
    throw ApiError.notFound(`画像がR2に存在しません (key: ${key})`);
  }
  return object;
}

export async function deletePhoto(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/* -------------------------------------------------------------------------- */
/* 署名付きURL（HMAC）                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULT_TTL_SECONDS = 60 * 15;

/** 署名鍵を解決する。未設定なら開発用の既定値を使う。 */
export function photoSecret(env: { PHOTO_URL_SECRET?: string }): string {
  return env.PHOTO_URL_SECRET?.trim() || 'dev-only-photo-url-secret';
}

/**
 * 画像取得用の署名付きURLパスを発行する。
 * secret には GEMINI_API_KEY とは別の値を使いたいところだが、MVPでは
 * Worker固有のシークレット（ここでは呼び出し側が渡す文字列）を利用する。
 */
export async function createSignedPhotoPath(
  photoId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<{ path: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await sign(`${photoId}:${expiresAt}`, secret);
  return {
    path: `/photos/${photoId}/content?expires=${expiresAt}&signature=${signature}`,
    expiresAt,
  };
}

/** 署名付きURLの検証。 */
export async function verifyPhotoSignature(
  photoId: string,
  expires: string | undefined,
  signature: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!expires || !signature) return false;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < Math.floor(Date.now() / 1000)) return false;

  const expected = await sign(`${photoId}:${expiresAt}`, secret);
  return timingSafeEqual(expected, signature);
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
