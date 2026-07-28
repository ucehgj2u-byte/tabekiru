import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { photos, type User } from '../db/schema';
import { assertHouseholdAccess, loadPhotoForUser } from '../lib/access';
import { optionalAuthMiddleware } from '../middleware/auth';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  buildPhotoKey,
  createSignedPhotoPath,
  getPhotoObject,
  isAllowedImageMime,
  putPhoto,
  resolveMimeType,
  verifyPhotoSignature,
} from '../services/r2Service';
import type { AppEnv } from '../types';

/** household配下のアップロード用（/households にマウント） */
export const householdPhotosRoute = new Hono<AppEnv>();

/** 単体写真用（/photos にマウント） */
export const photosRoute = new Hono<AppEnv>();

function photoSecret(env: AppEnv['Bindings']): string {
  return env.PHOTO_URL_SECRET?.trim() || 'dev-only-photo-url-secret';
}

/** POST /households/:id/photos — multipart画像アップロード → R2保存 → photos作成 */
householdPhotosRoute.post('/:id/photos', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw ApiError.badRequest(
      'multipart/form-data で file フィールドに画像を添付してください',
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (e) {
    // 原因を握りつぶすと調査できなくなるため、実際の例外内容も返す
    const reason = (e as Error)?.message ?? String(e);
    console.error('[photos] multipart解析に失敗', {
      contentType,
      contentLength: c.req.header('content-length'),
      reason,
    });
    throw ApiError.badRequest(
      `multipart/form-data の解析に失敗しました: ${reason}`,
      { content_type: contentType, content_length: c.req.header('content-length') ?? null },
    );
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    const keys = [...form.keys()];
    throw ApiError.badRequest(
      `file フィールドに画像ファイルが必要です（受信したフィールド: ${keys.length ? keys.join(', ') : 'なし'}）`,
    );
  }

  // 拡張子しか手掛かりがない環境（file.type が空）でも受け付けられるようにする
  const mimeType = resolveMimeType(file);
  if (!isAllowedImageMime(mimeType)) {
    throw ApiError.unprocessable(
      `対応していない画像形式です (${file.type || file.name || '不明'})。対応形式: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`,
    );
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw ApiError.badRequest('空のファイルはアップロードできません');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw ApiError.unprocessable(
      `画像サイズ(${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB)が上限(${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB)を超えています。スマホで撮った写真はそのままだと超えることがあります`,
    );
  }

  const photoId = newId('pho');
  const r2Key = buildPhotoKey(householdId, photoId, mimeType);

  await putPhoto(c.env.PHOTOS, r2Key, bytes, mimeType);

  await db.insert(photos).values({
    id: photoId,
    householdId,
    uploadedBy: user.id,
    r2Key,
    mimeType,
    status: 'uploaded',
  });

  const created = await db
    .select()
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);

  const signed = await createSignedPhotoPath(photoId, photoSecret(c.env));

  return c.json(
    {
      photo: created[0],
      size_bytes: bytes.byteLength,
      /** 署名付きURL（相対パス）。有効期限はUNIX秒。 */
      content_url: signed.path,
      content_url_expires_at: signed.expiresAt,
    },
    201,
  );
});

/** GET /households/:id/photos — アップロード済み写真一覧 */
householdPhotosRoute.get('/:id/photos', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const rows = await db
    .select()
    .from(photos)
    .where(eq(photos.householdId, householdId))
    .orderBy(desc(photos.createdAt))
    .limit(100);

  return c.json({ photos: rows });
});

/** GET /photos/:id — メタ情報 + 署名付きURL再発行 */
photosRoute.get('/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const photo = await loadPhotoForUser(db, c.req.param('id'), user.id);
  const signed = await createSignedPhotoPath(photo.id, photoSecret(c.env));

  return c.json({
    photo,
    content_url: signed.path,
    content_url_expires_at: signed.expiresAt,
  });
});

/**
 * GET /photos/:id/content — 画像本体を返す。
 * 署名付きURL(?expires=&signature=)、または Bearer認証のどちらかで参照できる。
 * 認証必須ルートより先に index.ts でマウントする。
 */
export const photoContentRoute = new Hono<AppEnv>();

photoContentRoute.get('/:id/content', optionalAuthMiddleware, async (c) => {
  const db = c.get('db');
  const photoId = c.req.param('id');

  const signatureOk = await verifyPhotoSignature(
    photoId,
    c.req.query('expires'),
    c.req.query('signature'),
    photoSecret(c.env),
  );

  const rows = await db
    .select()
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('写真が見つかりません');
  }
  const photo = rows[0];

  if (!signatureOk) {
    // 署名が無い/不正な場合はメンバーシップで判定する
    const user = c.get('user') as User | undefined;
    if (!user) {
      throw ApiError.unauthorized(
        '有効な署名付きURL、またはAuthorizationヘッダが必要です',
      );
    }
    await loadPhotoForUser(db, photoId, user.id);
  }

  // ストリーム(object.body)をそのまま返すと、画像認識ジョブなどの
  // バックグラウンド処理と並行したときにレスポンスが滞留するため、
  // 一度メモリに読み切ってから返す（上限10MBなので安全に載る）。
  const object = await getPhotoObject(c.env.PHOTOS, photo.r2Key);
  const bytes = await object.arrayBuffer();

  return c.body(bytes, {
    headers: {
      'content-type': photo.mimeType,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, max-age=300',
      etag: object.httpEtag,
    },
  });
});
