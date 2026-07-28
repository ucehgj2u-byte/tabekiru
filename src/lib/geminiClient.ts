import type { Bindings } from '../types';

/**
 * Gemini API 呼び出しの共通ラッパー。
 * recognitionService / recipeService はどちらもこのモジュール経由で呼ぶ。
 * SDKは使わず REST を fetch で叩く。
 */

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * 既定モデル。
 * `gemini-3-flash` という名前は v1beta では提供されておらず（404）、
 * 実際に呼べる名前は `gemini-3-flash-preview` のため、こちらを既定にしている。
 * レート制限に当たる場合は環境変数 GEMINI_MODEL で
 * `gemini-3.1-flash-lite` などに切り替える。
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3-flash-preview';

export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

/** Gemini の responseSchema（型名は大文字）の最小型定義。 */
export type GeminiSchema = {
  type: 'ARRAY' | 'OBJECT' | 'STRING' | 'NUMBER' | 'BOOLEAN' | 'INTEGER';
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  description?: string;
};

export type GeminiErrorCode =
  | 'missing_api_key'
  | 'rate_limited'
  | 'api_error'
  | 'blocked'
  | 'invalid_json'
  | 'network_error';

export class GeminiError extends Error {
  readonly code: GeminiErrorCode;
  readonly httpStatus?: number;

  constructor(code: GeminiErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 環境変数から使用モデル名を解決する。 */
export function resolveModel(env: Pick<Bindings, 'GEMINI_MODEL'>): string {
  return env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/** ArrayBuffer を Base64 文字列に変換する（Workers に Buffer が無いため自前実装）。 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // 引数展開の上限を避けるため分割する
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export type GenerateJsonOptions = {
  env: Pick<Bindings, 'GEMINI_API_KEY' | 'GEMINI_MODEL'>;
  parts: GeminiPart[];
  responseSchema: GeminiSchema;
  /** 生成の揺れを抑えたい場合に指定（0〜2） */
  temperature?: number;
};

export type GenerateJsonResult<T> = {
  data: T;
  modelName: string;
};

/**
 * JSONモード（responseMimeType: application/json）で Gemini を呼び出し、
 * パース済みの結果と実際に使ったモデル名を返す。
 *
 * MVPではリトライしない。JSONとして読めない場合・429の場合は
 * GeminiError を投げ、呼び出し側でジョブを失敗扱いにする。
 */
export async function generateJson<T = unknown>(
  options: GenerateJsonOptions,
): Promise<GenerateJsonResult<T>> {
  const { env, parts, responseSchema, temperature } = options;

  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiError(
      'missing_api_key',
      'GEMINI_API_KEY が設定されていません。`wrangler secret put GEMINI_API_KEY`（ローカルは .dev.vars）で設定してください',
    );
  }

  const modelName = resolveModel(env);
  const url = `${GEMINI_ENDPOINT}/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      ...(temperature !== undefined ? { temperature } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GeminiError(
      'network_error',
      `Gemini APIへの接続に失敗しました: ${(e as Error).message}`,
    );
  }

  if (response.status === 429) {
    const detail = await safeText(response);
    throw new GeminiError(
      'rate_limited',
      `Gemini APIのレート制限(429)に達しました。モデル ${modelName} の無料枠上限の可能性があります。GEMINI_MODEL を gemini-3.1-flash-lite に切り替えるか、時間をおいて再実行してください。詳細: ${detail}`,
      429,
    );
  }

  if (!response.ok) {
    const detail = await safeText(response);
    throw new GeminiError(
      'api_error',
      `Gemini APIがエラーを返しました (HTTP ${response.status}): ${detail}`,
      response.status,
    );
  }

  const payload = (await response.json().catch(() => null)) as GeminiResponse | null;
  if (!payload) {
    throw new GeminiError(
      'invalid_json',
      'Gemini APIのレスポンスをJSONとして解析できませんでした',
    );
  }

  const blockReason = payload.promptFeedback?.blockReason;
  if (blockReason) {
    throw new GeminiError(
      'blocked',
      `Gemini APIがリクエストをブロックしました: ${blockReason}`,
    );
  }

  const text = extractText(payload);
  if (!text) {
    const finishReason = payload.candidates?.[0]?.finishReason ?? 'unknown';
    throw new GeminiError(
      'invalid_json',
      `Gemini APIのレスポンスにテキストが含まれていませんでした (finishReason: ${finishReason})`,
    );
  }

  try {
    return { data: JSON.parse(text) as T, modelName };
  } catch {
    throw new GeminiError(
      'invalid_json',
      `Gemini APIのレスポンスをJSONとして解析できませんでした: ${text.slice(0, 300)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
};

function extractText(payload: GeminiResponse): string {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return parts
    // 思考モデルは thought: true のpartを混ぜてくることがある。
    // これを連結するとJSONが壊れるため除外する。
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
    .trim();
}

async function safeText(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 500);
  } catch {
    return '(レスポンス本文を取得できませんでした)';
  }
}
