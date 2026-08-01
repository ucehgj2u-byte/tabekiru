import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  foodCatalog,
  inventoryEvents,
  inventoryLots,
  storageLocations,
  type InventoryLot,
} from '../db/schema';
import { nowUtc, todayUtc } from '../lib/datetime';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import { resolveOpenedExpiry } from '../lib/openedShelfLife';

/**
 * 在庫ロットの生成・更新と、inventory_events への追記をまとめる。
 * inventory_events は追記のみ（UPDATE/DELETEしない）。
 */

/** location_id が同じhouseholdのものか検証する。 */
export async function assertLocationInHousehold(
  db: Db,
  householdId: string,
  locationId: string,
): Promise<void> {
  const rows = await db
    .select({ id: storageLocations.id })
    .from(storageLocations)
    .where(
      and(
        eq(storageLocations.id, locationId),
        eq(storageLocations.householdId, householdId),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.unprocessable(
      '指定されたlocation_idはこのhouseholdの保存場所ではありません',
    );
  }
}

export async function assertFoodCatalogExists(
  db: Db,
  foodCatalogId: string,
): Promise<void> {
  const rows = await db
    .select({ id: foodCatalog.id })
    .from(foodCatalog)
    .where(eq(foodCatalog.id, foodCatalogId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.unprocessable('指定されたfood_catalog_idが存在しません');
  }
}

export type CreateLotInput = {
  householdId: string;
  addedBy: string;
  displayName: string;
  category?: string | null;
  quantity: number;
  unit: string;
  expiresOn: string;
  purchasedOn?: string | null;
  locationId?: string | null;
  foodCatalogId?: string | null;
  source: 'manual' | 'scan';
  photoId?: string | null;
  note?: string | null;
};

/** 在庫ロットを作成し、created イベントを追記する。 */
export async function createLot(
  db: Db,
  input: CreateLotInput,
): Promise<InventoryLot> {
  if (input.locationId) {
    await assertLocationInHousehold(db, input.householdId, input.locationId);
  }
  if (input.foodCatalogId) {
    await assertFoodCatalogExists(db, input.foodCatalogId);
  }

  const lotId = newId('lot');
  const timestamp = nowUtc();

  await db.insert(inventoryLots).values({
    id: lotId,
    householdId: input.householdId,
    foodCatalogId: input.foodCatalogId ?? null,
    displayName: input.displayName,
    category: input.category ?? null,
    quantity: input.quantity,
    unit: input.unit,
    locationId: input.locationId ?? null,
    purchasedOn: input.purchasedOn ?? null,
    expiresOn: input.expiresOn,
    status: 'active',
    source: input.source,
    photoId: input.photoId ?? null,
    addedBy: input.addedBy,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await appendEvent(db, {
    lotId,
    householdId: input.householdId,
    eventType: 'created',
    quantity: input.quantity,
    actorUserId: input.addedBy,
    note: input.note ?? null,
  });

  return await getLotOrThrow(db, lotId);
}

export async function getLotOrThrow(db: Db, lotId: string): Promise<InventoryLot> {
  const rows = await db
    .select()
    .from(inventoryLots)
    .where(eq(inventoryLots.id, lotId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('在庫(inventory_lot)が見つかりません');
  }
  return rows[0];
}

export type AppendEventInput = {
  lotId: string;
  householdId: string;
  eventType: 'created' | 'adjusted' | 'consumed' | 'discarded' | 'opened';
  /** イベントで動いた数量（consumed/discardedは減った量、createdは初期数量） */
  quantity: number;
  actorUserId: string;
  note?: string | null;
};

export async function appendEvent(
  db: Db,
  input: AppendEventInput,
): Promise<void> {
  await db.insert(inventoryEvents).values({
    id: newId('evt'),
    inventoryLotId: input.lotId,
    householdId: input.householdId,
    eventType: input.eventType,
    quantity: input.quantity,
    actorUserId: input.actorUserId,
    note: input.note ?? null,
    occurredAt: nowUtc(),
  });
}

/**
 * 消費・廃棄の共通処理。
 * quantity 未指定なら残量すべてを対象にする。0になったら status を更新する。
 */
export async function consumeOrDiscard(
  db: Db,
  lot: InventoryLot,
  actorUserId: string,
  kind: 'consumed' | 'discarded',
  requestedQuantity: number | undefined,
  note: string | undefined,
): Promise<InventoryLot> {
  if (lot.status !== 'active') {
    throw ApiError.conflict(
      `この在庫は既に ${lot.status} のため操作できません`,
    );
  }

  const amount = requestedQuantity ?? lot.quantity;
  if (amount <= 0) {
    throw ApiError.badRequest('数量は0より大きい値を指定してください');
  }
  if (amount > lot.quantity + 1e-9) {
    throw ApiError.unprocessable(
      `残量(${lot.quantity}${lot.unit})を超える数量は指定できません`,
    );
  }

  const remaining = roundQuantity(lot.quantity - amount);
  const nextStatus = remaining <= 0 ? kind : 'active';

  await db
    .update(inventoryLots)
    .set({
      quantity: remaining,
      status: nextStatus,
      updatedAt: nowUtc(),
    })
    .where(eq(inventoryLots.id, lot.id));

  await appendEvent(db, {
    lotId: lot.id,
    householdId: lot.householdId,
    eventType: kind,
    quantity: amount,
    actorUserId,
    note: note ?? null,
  });

  return await getLotOrThrow(db, lot.id);
}

/**
 * 在庫を「開封済み」にする。
 * カテゴリ別の固定ルールで期限を再計算し（元の期限より延びることはない）、
 * opened イベントを追記する。既に開封済み・active以外なら弾く。
 */
export async function openLot(
  db: Db,
  lot: InventoryLot,
  actorUserId: string,
): Promise<InventoryLot> {
  if (lot.status !== 'active') {
    throw ApiError.conflict(`この在庫は既に ${lot.status} のため開封できません`);
  }
  if (lot.openedAt) {
    throw ApiError.conflict('この在庫は既に開封済みです');
  }

  const openedOn = todayUtc();
  const nextExpiresOn = resolveOpenedExpiry(lot.category, openedOn, lot.expiresOn);

  await db
    .update(inventoryLots)
    .set({
      openedAt: openedOn,
      expiresOn: nextExpiresOn,
      updatedAt: nowUtc(),
    })
    .where(eq(inventoryLots.id, lot.id));

  await appendEvent(db, {
    lotId: lot.id,
    householdId: lot.householdId,
    eventType: 'opened',
    quantity: lot.quantity,
    actorUserId,
    note: `消費期限を ${nextExpiresOn} に更新（開封済み）`,
  });

  return await getLotOrThrow(db, lot.id);
}

/** 浮動小数の誤差を丸める（小数第3位まで）。 */
export function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}
