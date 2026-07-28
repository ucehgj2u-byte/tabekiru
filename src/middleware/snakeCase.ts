import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

/**
 * レスポンスJSONのキーをsnake_caseに揃えるミドルウェア。
 *
 * DrizzleはTS側のプロパティ名(camelCase)で行を返すが、APIの契約は
 * DBカラムと同じsnake_case（display_name, expires_on など）に統一したい。
 * 変換を1箇所に集約するため、レスポンス直前でまとめて変換する。
 */
export const snakeCaseResponse: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  const contentType = c.res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return;

  const original = await c.res.clone().json();
  const converted = convertKeys(original);

  c.res = new Response(JSON.stringify(converted), {
    status: c.res.status,
    headers: c.res.headers,
  });
};

export function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function convertKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertKeys);
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[camelToSnake(k)] = convertKeys(v);
  }
  return out;
}
