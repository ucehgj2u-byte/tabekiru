import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { ApiError, errorHandler } from './lib/errors';
import { authMiddleware, dbMiddleware } from './middleware/auth';
import { snakeCaseResponse } from './middleware/snakeCase';
import { eventsRoute } from './routes/events';
import { foodCatalogRoute } from './routes/foodCatalog';
import { householdsRoute } from './routes/households';
import { householdInventoryRoute, inventoryRoute } from './routes/inventory';
import { householdPhotosRoute, photoContentRoute, photosRoute } from './routes/photos';
import {
  photoRecognizeRoute,
  recognitionCandidatesRoute,
  recognitionJobsRoute,
} from './routes/recognition';
import { recipesRoute } from './routes/recipes';
import { storageLocationsRoute } from './routes/storageLocations';
import type { AppEnv } from './types';
// 動作確認用の簡易GUI（wrangler.toml の Text ルールで文字列として取り込む）
import appHtml from './ui/app.html';

/**
 * 食品ロス削減アプリ バックエンド（Cloudflare Workers + Hono）
 *
 * 認証: Authorization: Bearer <token>（MVPの簡易認証。middleware/auth.ts 参照）
 */
const app = new Hono<AppEnv>();

app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type', 'X-User-Email', 'X-User-Display-Name'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));
app.use('*', snakeCaseResponse);
app.use('*', dbMiddleware);

app.onError(errorHandler);
app.notFound(() => {
  throw ApiError.notFound('エンドポイントが見つかりません');
});

/** 簡易GUI（認証不要。APIへのアクセスはブラウザ側がBearerトークンを付ける） */
app.get('/', (c) => c.html(appHtml));

/** ヘルスチェック（認証不要） */
app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'food-loss-backend',
    time: new Date().toISOString(),
  }),
);

/**
 * 画像本体の配信。署名付きURLでも参照できるよう、認証必須ルートより先に登録する。
 * （Honoは登録順にハンドラを合成するため、ここで先にマッチさせる）
 */
app.route('/photos', photoContentRoute);

/* ------------------------------ 認証必須ゾーン ------------------------------ */

app.use('/households/*', authMiddleware);
app.use('/photos/*', authMiddleware);
app.use('/inventory/*', authMiddleware);
app.use('/recognition-jobs/*', authMiddleware);
app.use('/recognition-candidates/*', authMiddleware);
app.use('/food-catalog', authMiddleware);
app.use('/food-catalog/*', authMiddleware);
app.use('/me', authMiddleware);

/** 認証済みユーザー自身の情報（トークン確認用） */
app.get('/me', (c) => c.json({ user: c.get('user') }));

// /households 配下（順番に合成されるため、同じprefixに複数ルーターをマウントできる）
app.route('/households', householdsRoute);
app.route('/households', storageLocationsRoute);
app.route('/households', householdPhotosRoute);
app.route('/households', householdInventoryRoute);
app.route('/households', eventsRoute);
app.route('/households', recipesRoute);

app.route('/photos', photosRoute);
app.route('/photos', photoRecognizeRoute);

app.route('/recognition-jobs', recognitionJobsRoute);
app.route('/recognition-candidates', recognitionCandidatesRoute);
app.route('/inventory', inventoryRoute);
app.route('/food-catalog', foodCatalogRoute);

export default app;
