import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import app from '../src/index';

/**
 * テスト用のリクエストヘルパー。
 * token をそのまま Bearer トークン（= auth_user_id）として送る。
 */
export async function api(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<Response> {
  const { token = 'user-a', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof rest.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const ctx = createExecutionContext();
  const res = await app.request(
    `http://localhost${path}`,
    { ...rest, headers },
    env,
    ctx,
  );
  // waitUntil() で登録した非同期処理（画像認識ジョブ）の完了を待つ
  await waitOnExecutionContext(ctx);
  return res;
}

export async function apiJson<T = any>(
  path: string,
  init: RequestInit & { token?: string | null } = {},
): Promise<{ status: number; body: T }> {
  const res = await api(path, init);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

export const jsonBody = (value: unknown) => JSON.stringify(value);

/** household を1つ作り、id を返す。 */
export async function createHousehold(
  token = 'user-a',
  name = 'テスト家族',
): Promise<string> {
  const { status, body } = await apiJson('/households', {
    method: 'POST',
    body: jsonBody({ name }),
    token,
  });
  if (status !== 201) {
    throw new Error(`household作成に失敗: ${status} ${JSON.stringify(body)}`);
  }
  return body.household.id;
}

/** 'YYYY-MM-DD' で今日から n 日後。 */
export function dayFromToday(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** 最小の有効なPNG（1x1）。 */
export function tinyPngBytes(): Uint8Array {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Gemini の generateContent レスポンス形（JSONモード）を組み立てる。 */
export function geminiJsonResponse(payload: unknown) {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(payload) }] },
        finishReason: 'STOP',
      },
    ],
  };
}
