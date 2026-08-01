import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { photos, recognitionCandidates, recognitionJobs } from '../db/schema';
import {
  FOOD_CATEGORIES,
  normalizeCategory,
  type FoodCategory,
} from '../lib/categories';
import { addDays, nowUtc, todayUtc } from '../lib/datetime';
import {
  arrayBufferToBase64,
  GeminiError,
  generateJson,
  type GeminiSchema,
} from '../lib/geminiClient';
import { newId } from '../lib/id';
import type { Bindings } from '../types';
import { getPhotoBytes } from './r2Service';

/**
 * Gemini API を使った食材の画像認識。
 * Gemini呼び出し自体は lib/geminiClient.ts に集約している。
 */

export type RecognitionResult = {
  detected_name: string;
  confidence: number;
  suggested_quantity?: number;
  suggested_unit?: string;
  category?: FoodCategory;
  /** パッケージに印字された賞味/消費期限を読み取れた場合のみ */
  printed_expiry_date?: string;
  /** 印字が無い食材（野菜など）の、一般的な日持ち日数 */
  estimated_shelf_life_days?: number;
};

const PROMPT = [
  'この写真に写っている食材を全て検出してください。写っていないものは含めないでください。',
  '各食材について次を返してください。',
  '- detected_name: 日本語の食材名',
  '- confidence: 確信度(0〜1)',
  '- suggested_quantity / suggested_unit: 推定数量と単位（例: 2 と 本）',
  `- category: 次のいずれか（${FOOD_CATEGORIES.join('、')}）`,
  '- printed_expiry_date: パッケージに賞味期限・消費期限が印字されていて読み取れる場合のみ、',
  '  YYYY-MM-DD 形式で返す。読み取れない、または印字が無い場合は空文字にすること。',
  '  年が省略されている場合(例「9.15」)は、直近の未来の日付として解釈すること。',
  '- estimated_shelf_life_days: 印字が読み取れない場合に、その食材を家庭で適切に保存したときの',
  '  一般的な日持ち日数の目安（例: 生の葉物なら5、根菜なら21、豆腐なら7）。',
  '  印字を読み取れた場合は0で構いません。',
].join('\n');

const RESPONSE_SCHEMA: GeminiSchema = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      detected_name: { type: 'STRING' },
      confidence: { type: 'NUMBER' },
      suggested_quantity: { type: 'NUMBER' },
      suggested_unit: { type: 'STRING' },
      category: { type: 'STRING' },
      printed_expiry_date: { type: 'STRING' },
      estimated_shelf_life_days: { type: 'NUMBER' },
    },
    required: ['detected_name', 'confidence'],
  },
};

/**
 * 画像バイナリから食材候補を検出する。
 * 失敗時は GeminiError を投げる（呼び出し側でジョブを failed にする）。
 */
export async function recognizeFood(
  env: Pick<Bindings, 'GEMINI_API_KEY' | 'GEMINI_MODEL'>,
  imageBytes: ArrayBuffer,
  mimeType: string,
): Promise<{ results: RecognitionResult[]; modelName: string }> {
  const { data, modelName } = await generateJson<unknown>({
    env,
    parts: [
      { text: PROMPT },
      {
        inline_data: {
          mime_type: mimeType,
          data: arrayBufferToBase64(imageBytes),
        },
      },
    ],
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0,
  });

  return { results: sanitizeResults(data), modelName };
}

/** 'YYYY-MM-DD' として妥当か（存在する日付か）。 */
function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * 一般的な日持ち日数から期限を推定する際の安全係数。
 * Geminiの「一般的な日持ち」知識は楽観的な値になりがちなため、
 * 牛乳・卵のように余裕を持たせた期限になるよう短縮する。
 * パッケージの印字を読み取れた場合（source: 'printed'）には適用しない。
 */
export const ESTIMATED_SHELF_LIFE_SAFETY_FACTOR = 0.8;

/**
 * 候補の消費期限を決める。
 * 1. パッケージの印字を読み取れていればそれを使う（source: 'printed'）
 * 2. 無ければ一般的な日持ち日数に安全係数を掛けて算出する（source: 'estimated'）
 * 3. どちらも無ければ null（UIで手入力してもらう）
 */
export function resolveSuggestedExpiry(
  result: RecognitionResult,
  today: string,
): { date: string; source: 'printed' | 'estimated' } | null {
  if (result.printed_expiry_date) {
    return { date: result.printed_expiry_date, source: 'printed' };
  }
  if (result.estimated_shelf_life_days !== undefined) {
    const days = Math.max(
      1,
      Math.floor(result.estimated_shelf_life_days * ESTIMATED_SHELF_LIFE_SAFETY_FACTOR),
    );
    return {
      date: addDays(today, days),
      source: 'estimated',
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 賞味期限だけを読み取る（期限撮影用カメラ）                                  */
/* -------------------------------------------------------------------------- */

export type ExpiryReadResult = {
  /** 'YYYY-MM-DD'。読み取れなければ null */
  expires_on: string | null;
  /** 画像から読めた日付の生テキスト（例: '26.08.20'） */
  raw_text: string | null;
  confidence: number | null;
};

const EXPIRY_PROMPT = [
  'これは食品パッケージの賞味期限・消費期限の印字を撮影した写真です。',
  '印字されている日付を1つだけ読み取ってください。',
  '- expires_on: YYYY-MM-DD 形式。読み取れない場合は空文字にすること。',
  '- raw_text: 画像に写っている日付の文字列をそのまま（例: 26.08.20）',
  '- confidence: 読み取りの確信度(0〜1)',
  '年が省略されている場合(例「8.20」)は、直近の未来の日付として解釈してください。',
  '「製造日」と「賞味期限」が両方写っている場合は、賞味期限の方を優先してください。',
].join('\n');

const EXPIRY_SCHEMA: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    expires_on: { type: 'STRING' },
    raw_text: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
  },
  required: ['expires_on'],
};

/**
 * 期限の印字だけを読み取る。
 * この写真はR2にもDBにも保存せず、読み取り後に破棄する。
 */
export async function readExpiryDate(
  env: Pick<Bindings, 'GEMINI_API_KEY' | 'GEMINI_MODEL'>,
  imageBytes: ArrayBuffer,
  mimeType: string,
): Promise<{ result: ExpiryReadResult; modelName: string }> {
  const { data, modelName } = await generateJson<Record<string, unknown>>({
    env,
    parts: [
      { text: EXPIRY_PROMPT },
      {
        inline_data: {
          mime_type: mimeType,
          data: arrayBufferToBase64(imageBytes),
        },
      },
    ],
    responseSchema: EXPIRY_SCHEMA,
    temperature: 0,
  });

  if (!data || typeof data !== 'object') {
    throw new GeminiError(
      'invalid_json',
      'Gemini APIのレスポンス形式が想定と異なりました',
    );
  }

  const raw = typeof data.expires_on === 'string' ? data.expires_on.trim() : '';
  return {
    result: {
      expires_on: isValidDateString(raw) ? raw : null,
      raw_text: typeof data.raw_text === 'string' && data.raw_text.trim()
        ? data.raw_text.trim()
        : null,
      confidence:
        typeof data.confidence === 'number' && Number.isFinite(data.confidence)
          ? Math.min(1, Math.max(0, data.confidence))
          : null,
    },
    modelName,
  };
}

/** Geminiの出力を検証して正規化する。壊れた要素は捨てる。 */
function sanitizeResults(data: unknown): RecognitionResult[] {
  if (!Array.isArray(data)) {
    throw new GeminiError(
      'invalid_json',
      'Gemini APIのレスポンスが配列ではありませんでした',
    );
  }

  const results: RecognitionResult[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const name = typeof item.detected_name === 'string' ? item.detected_name.trim() : '';
    if (!name) continue;

    const confidence =
      typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        ? Math.min(1, Math.max(0, item.confidence))
        : 0;

    const quantity =
      typeof item.suggested_quantity === 'number' &&
      Number.isFinite(item.suggested_quantity) &&
      item.suggested_quantity > 0
        ? item.suggested_quantity
        : undefined;

    const unit =
      typeof item.suggested_unit === 'string' && item.suggested_unit.trim()
        ? item.suggested_unit.trim()
        : undefined;

    const category = normalizeCategory(item.category);

    // 'YYYY-MM-DD' として妥当なものだけ採用する
    const printed =
      typeof item.printed_expiry_date === 'string' &&
      isValidDateString(item.printed_expiry_date.trim())
        ? item.printed_expiry_date.trim()
        : undefined;

    const shelfLife =
      typeof item.estimated_shelf_life_days === 'number' &&
      Number.isFinite(item.estimated_shelf_life_days) &&
      item.estimated_shelf_life_days > 0
        ? Math.min(365, Math.round(item.estimated_shelf_life_days))
        : undefined;

    // 確信度が低い候補もそのまま登録し、UI側で区別できるようにする
    results.push({
      detected_name: name,
      confidence,
      ...(quantity !== undefined ? { suggested_quantity: quantity } : {}),
      ...(unit !== undefined ? { suggested_unit: unit } : {}),
      ...(category ? { category } : {}),
      ...(printed ? { printed_expiry_date: printed } : {}),
      ...(shelfLife !== undefined ? { estimated_shelf_life_days: shelfLife } : {}),
    });
  }
  return results;
}

/**
 * ジョブを実行し、結果を recognition_candidates に保存する。
 * ルートからは waitUntil() でバックグラウンド実行される。
 * 例外は投げず、失敗はジョブのステータスに記録する。
 */
export async function runRecognitionJob(
  db: Db,
  env: Bindings,
  jobId: string,
  photoId: string,
): Promise<void> {
  try {
    await db
      .update(recognitionJobs)
      .set({ status: 'processing', startedAt: nowUtc() })
      .where(eq(recognitionJobs.id, jobId));

    const photoRows = await db
      .select()
      .from(photos)
      .where(eq(photos.id, photoId))
      .limit(1);
    if (photoRows.length === 0) {
      throw new Error('対象の写真が見つかりません');
    }
    const photo = photoRows[0];

    const bytes = await getPhotoBytes(env.PHOTOS, photo.r2Key);
    const { results, modelName } = await recognizeFood(env, bytes, photo.mimeType);

    if (results.length > 0) {
      const today = todayUtc();
      await db.insert(recognitionCandidates).values(
        results.map((r) => {
          // 印字を読み取れていればそれを優先し、無ければ一般的な日持ちから逆算する
          const expiry = resolveSuggestedExpiry(r, today);
          return {
            id: newId('cand'),
            jobId,
            detectedName: r.detected_name,
            confidence: r.confidence,
            suggestedQuantity: r.suggested_quantity ?? null,
            suggestedUnit: r.suggested_unit ?? null,
            suggestedCategory: r.category ?? null,
            suggestedExpiresOn: expiry?.date ?? null,
            expirySource: expiry?.source ?? null,
            // MVPでは bounding box は常に null
            boundingBoxJson: null,
            status: 'pending' as const,
          };
        }),
      );
    }

    await db
      .update(recognitionJobs)
      .set({
        status: 'completed',
        modelName,
        completedAt: nowUtc(),
        errorMessage: null,
      })
      .where(eq(recognitionJobs.id, jobId));

    await db
      .update(photos)
      .set({ status: 'processed' })
      .where(eq(photos.id, photoId));
  } catch (e) {
    const message =
      e instanceof GeminiError
        ? `[${e.code}] ${e.message}`
        : ((e as Error)?.message ?? String(e));

    await db
      .update(recognitionJobs)
      .set({
        status: 'failed',
        errorMessage: message.slice(0, 1000),
        completedAt: nowUtc(),
      })
      .where(eq(recognitionJobs.id, jobId));

    await db
      .update(photos)
      .set({ status: 'failed' })
      .where(eq(photos.id, photoId));

    console.error('[recognition] job failed', jobId, message);
  }
}
