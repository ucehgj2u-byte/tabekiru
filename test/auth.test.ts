import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, apiJson, jsonBody } from './helpers';

const RESEND_ORIGIN = 'https://api.resend.com';

let resendCalls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  resendCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockResend() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(RESEND_ORIGIN)) {
      throw new Error(`想定外の外部リクエスト: ${url}`);
    }
    const body = init?.body ? JSON.parse(init.body as string) : null;
    resendCalls.push({ url, body });
    return new Response(JSON.stringify({ id: 'email_test_id' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** メール本文から /auth/verify?token=... のトークンを取り出す。 */
function extractToken(html: string): string {
  const m = /\/auth\/verify\?token=([0-9a-f]+)/.exec(html);
  if (!m) throw new Error(`メール本文からトークンを抽出できませんでした: ${html}`);
  return m[1];
}

describe('POST /auth/magic-link', () => {
  it('メールでログインリンクを送る', async () => {
    mockResend();
    const { status, body } = await apiJson('/auth/magic-link', {
      method: 'POST',
      body: jsonBody({ email: 'sample@example.com' }),
      token: null,
    });

    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(resendCalls).toHaveLength(1);
    expect(resendCalls[0].body.to).toEqual(['sample@example.com']);
    expect(resendCalls[0].body.html).toContain('/auth/verify?token=');
  });

  it('不正なメールアドレスは400', async () => {
    const { status } = await apiJson('/auth/magic-link', {
      method: 'POST',
      body: jsonBody({ email: 'not-an-email' }),
      token: null,
    });
    expect(status).toBe(400);
  });
});

describe('GET /auth/verify', () => {
  it('トークンを検証してセッションJWTを発行し、そのままAPIを呼べる', async () => {
    mockResend();
    await apiJson('/auth/magic-link', {
      method: 'POST',
      body: jsonBody({ email: 'verify-user@example.com' }),
      token: null,
    });
    const rawToken = extractToken(resendCalls[0].body.html);

    const { status, body } = await apiJson(
      `/auth/verify?token=${rawToken}`,
      { token: null, headers: { Accept: 'application/json' } },
    );
    expect(status).toBe(200);
    expect(body.token).toEqual(expect.any(String));
    expect(body.user.email).toBe('verify-user@example.com');

    // 発行されたJWTでそのままAPIを呼べる
    const me = await api('/me', {
      token: null,
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as any;
    expect(meBody.user.email).toBe('verify-user@example.com');
  });

  it('同じトークンは2回使えない', async () => {
    mockResend();
    await apiJson('/auth/magic-link', {
      method: 'POST',
      body: jsonBody({ email: 'reuse-user@example.com' }),
      token: null,
    });
    const rawToken = extractToken(resendCalls[0].body.html);

    const first = await apiJson(`/auth/verify?token=${rawToken}`, {
      token: null,
      headers: { Accept: 'application/json' },
    });
    expect(first.status).toBe(200);

    const second = await apiJson(`/auth/verify?token=${rawToken}`, {
      token: null,
      headers: { Accept: 'application/json' },
    });
    expect(second.status).toBe(401);
  });

  it('存在しないトークンは401', async () => {
    const { status } = await apiJson('/auth/verify?token=does-not-exist', {
      token: null,
      headers: { Accept: 'application/json' },
    });
    expect(status).toBe(401);
  });

  it('ブラウザからのアクセスにはlocalStorageに保存してリダイレクトするHTMLを返す', async () => {
    mockResend();
    await apiJson('/auth/magic-link', {
      method: 'POST',
      body: jsonBody({ email: 'html-user@example.com' }),
      token: null,
    });
    const rawToken = extractToken(resendCalls[0].body.html);

    const res = await api(`/auth/verify?token=${rawToken}`, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain("localStorage.setItem('token'");
  });
});
