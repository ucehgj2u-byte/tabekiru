import { Hono } from 'hono';
import { ApiError } from '../lib/errors';
import { ResendError } from '../lib/resendClient';
import { magicLinkRequestSchema, parseJsonBody } from '../lib/validators';
import {
  consumeMagicLink,
  requestMagicLink,
  signSessionToken,
} from '../services/authService';
import type { AppEnv } from '../types';

/**
 * マジックリンクログイン。認証不要ゾーン（src/index.ts で authMiddleware の対象外にする）。
 */
export const authRoute = new Hono<AppEnv>();

/** POST /auth/magic-link — ログイン用リンクをメールで送る。 */
authRoute.post('/magic-link', async (c) => {
  const db = c.get('db');
  const { email } = await parseJsonBody(c, magicLinkRequestSchema);
  const origin = new URL(c.req.url).origin;

  try {
    await requestMagicLink(db, c.env, email, origin);
  } catch (e) {
    if (e instanceof ResendError) {
      const status = e.code === 'missing_api_key' ? 500 : 502;
      throw new ApiError(status, `resend_${e.code}`, e.message);
    }
    throw e;
  }

  return c.json({ sent: true });
});

/**
 * GET /auth/verify?token=...
 * メール本文のリンク先。ブラウザからの通常アクセスにはセッションを保存して
 * `/` に戻るHTMLを返す。`Accept: application/json` の場合はJSONで
 * `{ token, user }` を返す（curl等の動作確認・API利用向け）。
 */
authRoute.get('/verify', async (c) => {
  const db = c.get('db');
  const token = c.req.query('token') ?? '';

  const user = await consumeMagicLink(db, token);
  const sessionToken = await signSessionToken(c.env, user);

  if ((c.req.header('accept') ?? '').includes('application/json')) {
    return c.json({ token: sessionToken, user });
  }
  return c.html(renderLoginSuccessHtml(sessionToken));
});

function renderLoginSuccessHtml(sessionToken: string): string {
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>ログイン中…</title></head>
<body>
  <p>ログインしています…</p>
  <script>
    localStorage.setItem('token', ${JSON.stringify(sessionToken)});
    location.replace('/');
  </script>
</body>
</html>`;
}
