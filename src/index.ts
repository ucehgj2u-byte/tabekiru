import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createDb } from './db/client';
import { ApiError, errorHandler } from './lib/errors';
import { authMiddleware, dbMiddleware } from './middleware/auth';
import { snakeCaseResponse } from './middleware/snakeCase';
import { authRoute } from './routes/auth';
import { eventsRoute } from './routes/events';
import { foodCatalogRoute } from './routes/foodCatalog';
import { householdsRoute } from './routes/households';
import { householdInventoryRoute, inventoryRoute } from './routes/inventory';
import { householdNotificationsRoute } from './routes/notifications';
import { householdPhotosRoute, photoContentRoute, photosRoute } from './routes/photos';
import {
  photoRecognizeRoute,
  recognitionCandidatesRoute,
  recognitionJobsRoute,
} from './routes/recognition';
import { recipesRoute } from './routes/recipes';
import { storageLocationsRoute } from './routes/storageLocations';
import { runExpiryNotifications } from './services/notificationService';
import type { AppEnv, Bindings } from './types';
// 動作確認用の簡易GUI（wrangler.toml の Text ルールで文字列として取り込む）
import appHtml from './ui/app.html';

/**
 * 食品ロス削減アプリ バックエンド（Cloudflare Workers + Hono）
 *
 * 認証: マジックリンクログイン（POST /auth/magic-link → GET /auth/verify）で
 * 発行したセッションJWTを Authorization: Bearer <JWT> で送る。middleware/auth.ts 参照。
 */
const app = new Hono<AppEnv>();

app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Authorization', 'Content-Type'],
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

/** マジックリンクログイン（認証不要） */
app.route('/auth', authRoute);

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
app.route('/households', householdNotificationsRoute);

app.route('/photos', photosRoute);
app.route('/photos', photoRecognizeRoute);

app.route('/recognition-jobs', recognitionJobsRoute);
app.route('/recognition-candidates', recognitionCandidatesRoute);
app.route('/inventory', inventoryRoute);
app.route('/food-catalog', foodCatalogRoute);

/** テストでは `app.request(...)` を直接使うため named export も残す。 */
export { app };

export default {
  fetch: app.fetch,
  /**
   * 期限が近い食材のメール通知（wrangler.toml の [triggers] crons で毎日実行）。
   * household単位の送信失敗は runExpiryNotifications 内でログに残しつつ継続する。
   */
  async scheduled(_controller: ScheduledController, env: Bindings, _ctx: ExecutionContext) {
    const db = createDb(env.DB);
    const result = await runExpiryNotifications(db, env);
    console.log('[scheduled] expiring-check', result);
  },
} satisfies ExportedHandler<Bindings>;
