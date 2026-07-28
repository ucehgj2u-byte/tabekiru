import { and, asc, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { inventoryEvents, inventoryLots, storageLocations } from '../db/schema';
import { assertHouseholdAccess, loadLotForUser } from '../lib/access';
import { addDays, daysUntil, nowUtc, todayUtc } from '../lib/datetime';
import { ApiError } from '../lib/errors';
import {
  consumeSchema,
  createInventorySchema,
  inventoryQuerySchema,
  parseJsonBody,
  parseQuery,
  patchInventorySchema,
} from '../lib/validators';
import {
  appendEvent,
  assertFoodCatalogExists,
  assertLocationInHousehold,
  consumeOrDiscard,
  createLot,
  getLotOrThrow,
  roundQuantity,
} from '../services/inventoryService';
import type { AppEnv } from '../types';

/** /households にマウント */
export const householdInventoryRoute = new Hono<AppEnv>();

/** /inventory にマウント */
export const inventoryRoute = new Hono<AppEnv>();

/**
 * GET /households/:id/inventory
 *   ?status=active|consumed|discarded|all
 *   &location_id=...
 *   &expiring_within_days=3
 * 期限が近い順（expires_on 昇順）でソートする。
 */
householdInventoryRoute.get('/:id/inventory', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const query = parseQuery(c, inventoryQuerySchema);

  const conditions = [eq(inventoryLots.householdId, householdId)];
  if (query.status !== 'all') {
    conditions.push(eq(inventoryLots.status, query.status));
  }
  if (query.location_id) {
    conditions.push(eq(inventoryLots.locationId, query.location_id));
  }
  if (query.category) {
    conditions.push(eq(inventoryLots.category, query.category));
  }
  const today = todayUtc();
  if (query.expiring_within_days !== undefined) {
    conditions.push(lte(inventoryLots.expiresOn, addDays(today, query.expiring_within_days)));
  }

  const rows = await db
    .select({
      lot: inventoryLots,
      location_name: storageLocations.name,
      location_type: storageLocations.type,
    })
    .from(inventoryLots)
    .leftJoin(storageLocations, eq(inventoryLots.locationId, storageLocations.id))
    .where(and(...conditions))
    // 期限が近い順。同日なら作成順。
    .orderBy(asc(inventoryLots.expiresOn), asc(inventoryLots.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  const items = rows.map(({ lot, location_name, location_type }) => ({
    ...lot,
    location_name,
    location_type,
    days_until_expiry: daysUntil(lot.expiresOn, today),
    is_expired: lot.expiresOn < today,
  }));

  return c.json({ items, count: items.length, today });
});

/** POST /households/:id/inventory — 手動での在庫登録 */
householdInventoryRoute.post('/:id/inventory', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const body = await parseJsonBody(c, createInventorySchema);

  const lot = await createLot(db, {
    householdId,
    addedBy: user.id,
    displayName: body.display_name,
    category: body.category ?? null,
    quantity: body.quantity,
    unit: body.unit,
    expiresOn: body.expires_on,
    purchasedOn: body.purchased_on ?? null,
    locationId: body.location_id ?? null,
    foodCatalogId: body.food_catalog_id ?? null,
    source: 'manual',
    note: body.note ?? null,
  });

  return c.json({ inventory_lot: lot }, 201);
});

/** PATCH /inventory/:id — 数量・保存場所などの修正（adjusted を記録） */
inventoryRoute.patch('/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const lot = await loadLotForUser(db, c.req.param('id'), user.id);

  if (lot.status !== 'active') {
    throw ApiError.conflict(`この在庫は既に ${lot.status} のため修正できません`);
  }

  const body = await parseJsonBody(c, patchInventorySchema);

  if (body.location_id) {
    await assertLocationInHousehold(db, lot.householdId, body.location_id);
  }
  if (body.food_catalog_id) {
    await assertFoodCatalogExists(db, body.food_catalog_id);
  }

  const nextQuantity =
    body.quantity !== undefined ? roundQuantity(body.quantity) : lot.quantity;

  await db
    .update(inventoryLots)
    .set({
      ...(body.display_name !== undefined ? { displayName: body.display_name } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.quantity !== undefined ? { quantity: nextQuantity } : {}),
      ...(body.unit !== undefined ? { unit: body.unit } : {}),
      ...(body.location_id !== undefined ? { locationId: body.location_id } : {}),
      ...(body.expires_on !== undefined ? { expiresOn: body.expires_on } : {}),
      ...(body.purchased_on !== undefined ? { purchasedOn: body.purchased_on } : {}),
      ...(body.food_catalog_id !== undefined
        ? { foodCatalogId: body.food_catalog_id }
        : {}),
      updatedAt: nowUtc(),
    })
    .where(eq(inventoryLots.id, lot.id));

  // 追記専用の履歴。quantity は修正後の数量を記録する。
  await appendEvent(db, {
    lotId: lot.id,
    householdId: lot.householdId,
    eventType: 'adjusted',
    quantity: nextQuantity,
    actorUserId: user.id,
    note: body.note ?? null,
  });

  const updated = await getLotOrThrow(db, lot.id);
  return c.json({ inventory_lot: updated });
});

/** GET /inventory/:id — 単体取得 */
inventoryRoute.get('/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const lot = await loadLotForUser(db, c.req.param('id'), user.id);
  return c.json({
    inventory_lot: lot,
    days_until_expiry: daysUntil(lot.expiresOn),
  });
});

/** POST /inventory/:id/consume — 消費登録 */
inventoryRoute.post('/:id/consume', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const lot = await loadLotForUser(db, c.req.param('id'), user.id);
  const body = await parseJsonBody(c, consumeSchema);

  const updated = await consumeOrDiscard(
    db,
    lot,
    user.id,
    'consumed',
    body.quantity,
    body.note,
  );
  return c.json({ inventory_lot: updated });
});

/** POST /inventory/:id/discard — 廃棄登録（食品ロス集計の元データ） */
inventoryRoute.post('/:id/discard', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const lot = await loadLotForUser(db, c.req.param('id'), user.id);
  const body = await parseJsonBody(c, consumeSchema);

  const updated = await consumeOrDiscard(
    db,
    lot,
    user.id,
    'discarded',
    body.quantity,
    body.note,
  );
  return c.json({ inventory_lot: updated });
});

/** GET /inventory/:id/events — このロットの履歴（参照のみ） */
inventoryRoute.get('/:id/events', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const lot = await loadLotForUser(db, c.req.param('id'), user.id);

  const events = await db
    .select()
    .from(inventoryEvents)
    .where(eq(inventoryEvents.inventoryLotId, lot.id))
    .orderBy(asc(inventoryEvents.occurredAt));

  return c.json({ events });
});
