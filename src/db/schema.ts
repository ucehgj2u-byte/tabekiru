import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/**
 * D1(SQLite) のスキーマ定義。
 * - 日付(purchased_on / expires_on)は 'YYYY-MM-DD' の文字列
 * - 日時(created_at など)は UTC の 'YYYY-MM-DD HH:MM:SS' 文字列
 */

const nowUtc = sql`(datetime('now'))`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  authUserId: text('auth_user_id').notNull().unique(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: text('created_at').notNull().default(nowUtc),
});

/**
 * マジックリンクログイン用のワンタイムトークン。
 * 生トークンは保存せず、SHA-256ハッシュのみを保存する（DB漏洩時の悪用を防ぐため）。
 */
export const magicLinkTokens = sqliteTable(
  'magic_link_tokens',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    /** 使用済みなら日時が入る。二重使用を防ぐため一度でも使ったら再利用不可にする */
    consumedAt: text('consumed_at'),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (t) => [index('magic_link_tokens_token_hash_idx').on(t.tokenHash)],
);

export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id),
  timezone: text('timezone').notNull().default('Asia/Tokyo'),
  createdAt: text('created_at').notNull().default(nowUtc),
});

export const householdMembers = sqliteTable(
  'household_members',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    status: text('status', { enum: ['active', 'invited'] }).notNull(),
    joinedAt: text('joined_at').notNull().default(nowUtc),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] })],
);

export const storageLocations = sqliteTable('storage_locations', {
  id: text('id').primaryKey(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id),
  name: text('name').notNull(),
  type: text('type', { enum: ['fridge', 'freezer', 'pantry'] }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const foodCatalog = sqliteTable(
  'food_catalog',
  {
    id: text('id').primaryKey(),
    canonicalName: text('canonical_name').notNull(),
    category: text('category'),
    defaultUnit: text('default_unit'),
    normalizedName: text('normalized_name').notNull(),
  },
  (t) => [index('food_catalog_normalized_idx').on(t.normalizedName)],
);

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  householdId: text('household_id')
    .notNull()
    .references(() => households.id),
  uploadedBy: text('uploaded_by')
    .notNull()
    .references(() => users.id),
  r2Key: text('r2_key').notNull(),
  mimeType: text('mime_type').notNull(),
  status: text('status', { enum: ['uploaded', 'processed', 'failed'] })
    .notNull()
    .default('uploaded'),
  createdAt: text('created_at').notNull().default(nowUtc),
});

export const inventoryLots = sqliteTable(
  'inventory_lots',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    foodCatalogId: text('food_catalog_id').references(() => foodCatalog.id),
    displayName: text('display_name').notNull(),
    /** 野菜・肉・魚介など（FOOD_CATEGORIES）。未分類は null */
    category: text('category'),
    quantity: real('quantity').notNull(),
    unit: text('unit').notNull(),
    locationId: text('location_id').references(() => storageLocations.id),
    purchasedOn: text('purchased_on'),
    expiresOn: text('expires_on').notNull(),
    /** 開封日。開封していなければ null。開封するとカテゴリ別ルールで expiresOn が短縮される */
    openedAt: text('opened_at'),
    status: text('status', { enum: ['active', 'consumed', 'discarded'] })
      .notNull()
      .default('active'),
    source: text('source', { enum: ['manual', 'scan'] }).notNull(),
    photoId: text('photo_id').references(() => photos.id),
    addedBy: text('added_by')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull().default(nowUtc),
    updatedAt: text('updated_at').notNull().default(nowUtc),
  },
  (t) => [
    index('inventory_expiry_idx').on(t.householdId, t.status, t.expiresOn),
    index('inventory_location_idx').on(t.householdId, t.locationId, t.status),
    index('inventory_category_idx').on(t.householdId, t.category, t.status),
  ],
);

/** 追記専用。UPDATE/DELETE を行うAPIは実装しない。 */
export const inventoryEvents = sqliteTable(
  'inventory_events',
  {
    id: text('id').primaryKey(),
    inventoryLotId: text('inventory_lot_id')
      .notNull()
      .references(() => inventoryLots.id),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    eventType: text('event_type', {
      enum: ['created', 'adjusted', 'consumed', 'discarded', 'opened'],
    }).notNull(),
    quantity: real('quantity').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id),
    note: text('note'),
    occurredAt: text('occurred_at').notNull().default(nowUtc),
  },
  (t) => [index('events_history_idx').on(t.householdId, t.occurredAt)],
);

export const recognitionJobs = sqliteTable(
  'recognition_jobs',
  {
    id: text('id').primaryKey(),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id),
    status: text('status', {
      enum: ['pending', 'processing', 'completed', 'failed'],
    })
      .notNull()
      .default('pending'),
    modelName: text('model_name'),
    errorMessage: text('error_message'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (t) => [index('recognition_jobs_photo_idx').on(t.photoId)],
);

export const recognitionCandidates = sqliteTable(
  'recognition_candidates',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => recognitionJobs.id),
    detectedName: text('detected_name').notNull(),
    confidence: real('confidence'),
    suggestedQuantity: real('suggested_quantity'),
    suggestedUnit: text('suggested_unit'),
    /** MVPでは常に null（Gemini Visionの座標精度が保証されないため） */
    boundingBoxJson: text('bounding_box_json'),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
      .notNull()
      .default('pending'),
    correctedName: text('corrected_name'),
    /** AIが推定した食材カテゴリ */
    suggestedCategory: text('suggested_category'),
    /** パッケージの印字から読み取った、または一般的な日持ちから推定した消費期限 */
    suggestedExpiresOn: text('suggested_expires_on'),
    /** 'printed'（印字を読み取り） / 'estimated'（一般的な日持ちから推定） */
    expirySource: text('expiry_source', { enum: ['printed', 'estimated'] }),
    inventoryLotId: text('inventory_lot_id').references(() => inventoryLots.id),
  },
  (t) => [index('recognition_candidates_job_idx').on(t.jobId)],
);

/**
 * レシピ提案の履歴。追記専用。
 * based_on_json / recipes_json は提案時点のスナップショットをJSON文字列で保持する
 * （在庫が後で消費・削除されても履歴の内容自体は変わらないようにするため）。
 */
export const recipeSuggestions = sqliteTable(
  'recipe_suggestions',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id),
    modelName: text('model_name').notNull(),
    selectionMode: text('selection_mode', {
      enum: ['selected', 'auto'],
    }).notNull(),
    basedOnJson: text('based_on_json').notNull(),
    recipesJson: text('recipes_json').notNull(),
    createdAt: text('created_at').notNull().default(nowUtc),
  },
  (t) => [
    index('recipe_suggestions_household_idx').on(t.householdId, t.createdAt),
  ],
);

export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;
export type User = typeof users.$inferSelect;
export type Household = typeof households.$inferSelect;
export type HouseholdMember = typeof householdMembers.$inferSelect;
export type StorageLocation = typeof storageLocations.$inferSelect;
export type FoodCatalogItem = typeof foodCatalog.$inferSelect;
export type Photo = typeof photos.$inferSelect;
export type InventoryLot = typeof inventoryLots.$inferSelect;
export type InventoryEvent = typeof inventoryEvents.$inferSelect;
export type RecognitionJob = typeof recognitionJobs.$inferSelect;
export type RecognitionCandidate = typeof recognitionCandidates.$inferSelect;
export type RecipeSuggestion = typeof recipeSuggestions.$inferSelect;
