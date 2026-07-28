import type { Context } from 'hono';
import { z } from 'zod';
import { FOOD_CATEGORIES } from './categories';
import { ApiError } from './errors';

/* -------------------------------------------------------------------------- */
/* 基本型                                                                      */
/* -------------------------------------------------------------------------- */

/** 'YYYY-MM-DD' 形式かつ実在する日付。 */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で指定してください')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, '存在しない日付です');

const nonEmptyString = (max = 200) => z.string().trim().min(1).max(max);

/** 食材カテゴリ（野菜・肉・魚介など） */
export const categoryEnum = z.enum(FOOD_CATEGORIES);
const positiveQuantity = z
  .number()
  .finite()
  .positive('数量は0より大きい値を指定してください');

/* -------------------------------------------------------------------------- */
/* households                                                                  */
/* -------------------------------------------------------------------------- */

export const createHouseholdSchema = z.object({
  name: nonEmptyString(100),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export const addMemberSchema = z
  .object({
    user_id: z.string().trim().min(1).optional(),
    email: z.email('メールアドレスの形式が正しくありません').optional(),
    display_name: z.string().trim().min(1).max(100).optional(),
    role: z.enum(['owner', 'member']).default('member'),
    status: z.enum(['active', 'invited']).default('invited'),
  })
  .refine((v) => v.user_id || v.email, {
    message: 'user_id または email のどちらかは必須です',
  });

/* -------------------------------------------------------------------------- */
/* storage_locations                                                           */
/* -------------------------------------------------------------------------- */

export const createStorageLocationSchema = z.object({
  name: nonEmptyString(100),
  type: z.enum(['fridge', 'freezer', 'pantry']),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

/* -------------------------------------------------------------------------- */
/* food_catalog                                                                */
/* -------------------------------------------------------------------------- */

export const foodCatalogQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/* -------------------------------------------------------------------------- */
/* inventory                                                                   */
/* -------------------------------------------------------------------------- */

export const inventoryQuerySchema = z.object({
  status: z.enum(['active', 'consumed', 'discarded', 'all']).default('active'),
  category: categoryEnum.optional(),
  location_id: z.string().trim().min(1).optional(),
  expiring_within_days: z.coerce.number().int().min(0).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createInventorySchema = z.object({
  display_name: nonEmptyString(100),
  category: categoryEnum.optional(),
  quantity: positiveQuantity,
  unit: nonEmptyString(20),
  expires_on: dateString,
  purchased_on: dateString.optional(),
  location_id: z.string().trim().min(1).optional(),
  food_catalog_id: z.string().trim().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

export const patchInventorySchema = z
  .object({
    display_name: nonEmptyString(100).optional(),
    category: categoryEnum.nullable().optional(),
    quantity: z.number().finite().min(0).optional(),
    unit: nonEmptyString(20).optional(),
    location_id: z.string().trim().min(1).nullable().optional(),
    expires_on: dateString.optional(),
    purchased_on: dateString.nullable().optional(),
    food_catalog_id: z.string().trim().min(1).nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) =>
      Object.keys(v).some((k) => k !== 'note' && v[k as keyof typeof v] !== undefined),
    { message: '更新する項目を1つ以上指定してください' },
  );

/** 消費・廃棄。quantity 省略時は残量すべてを対象にする。 */
export const consumeSchema = z.object({
  quantity: positiveQuantity.optional(),
  note: z.string().trim().max(500).optional(),
});

/* -------------------------------------------------------------------------- */
/* events                                                                      */
/* -------------------------------------------------------------------------- */

export const eventsQuerySchema = z
  .object({
    from: dateString.optional(),
    to: dateString.optional(),
    event_type: z
      .enum(['created', 'adjusted', 'consumed', 'discarded'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'from は to 以前の日付を指定してください',
  });

/* -------------------------------------------------------------------------- */
/* recognition                                                                 */
/* -------------------------------------------------------------------------- */

export const patchCandidateSchema = z
  .object({
    corrected_name: nonEmptyString(100).optional(),
    suggested_quantity: positiveQuantity.optional(),
    suggested_unit: nonEmptyString(20).optional(),
    suggested_category: categoryEnum.optional(),
    suggested_expires_on: dateString.optional(),
    status: z.enum(['pending', 'rejected']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '更新する項目を1つ以上指定してください',
  });

export const confirmCandidateSchema = z.object({
  /** 省略時は候補の suggested_expires_on（AIが読み取り/推定した期限）を使う */
  expires_on: dateString.optional(),
  category: categoryEnum.optional(),
  display_name: nonEmptyString(100).optional(),
  quantity: positiveQuantity.optional(),
  unit: nonEmptyString(20).optional(),
  location_id: z.string().trim().min(1).optional(),
  purchased_on: dateString.optional(),
  food_catalog_id: z.string().trim().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

/* -------------------------------------------------------------------------- */
/* recipes                                                                     */
/* -------------------------------------------------------------------------- */

export const recipeQuerySchema = z.object({
  /** レシピ生成に渡す食材の最大件数 */
  limit: z.coerce.number().int().min(1).max(30).default(12),
  /** 何日以内に期限が来る食材に絞るか（未指定なら期限順に上位 limit 件） */
  within_days: z.coerce.number().int().min(0).max(365).optional(),
});

/* -------------------------------------------------------------------------- */
/* パースヘルパー                                                              */
/* -------------------------------------------------------------------------- */

function formatIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

/** リクエストボディ(JSON)を検証する。失敗時は 400 を投げる。 */
export async function parseJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw ApiError.badRequest('リクエストボディをJSONとして解析できませんでした');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw ApiError.badRequest('入力値が不正です', formatIssues(result.error));
  }
  return result.data;
}

/** クエリパラメータを検証する。失敗時は 400 を投げる。 */
export function parseQuery<S extends z.ZodType>(
  c: Context,
  schema: S,
): z.output<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw ApiError.badRequest(
      'クエリパラメータが不正です',
      formatIssues(result.error),
    );
  }
  return result.data;
}

/** 任意のオブジェクトを検証する（multipart のフィールドなど）。 */
export function parseObject<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ApiError.badRequest('入力値が不正です', formatIssues(result.error));
  }
  return result.data;
}
