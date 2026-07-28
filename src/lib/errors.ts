import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** APIが返す業務エラー。ルート内で throw すると onError が整形して返す。 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }
  static unauthorized(message = '認証が必要です') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'このリソースへのアクセス権限がありません') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message = 'リソースが見つかりません') {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'conflict', message, details);
  }
  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, 'unprocessable_entity', message, details);
  }
  static internal(message = 'サーバー内部エラーが発生しました') {
    return new ApiError(500, 'internal_error', message);
  }
}

/** Honoの app.onError に渡すハンドラ。 */
export function errorHandler(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      },
      err.status,
    );
  }

  console.error('[unhandled error]', err);
  return c.json(
    {
      error: {
        code: 'internal_error',
        message: 'サーバー内部エラーが発生しました',
      },
    },
    500,
  );
}
