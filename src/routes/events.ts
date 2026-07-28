import { and, asc, count, desc, eq, gte, lte, sql, sum } from 'drizzle-orm';
import { Hono } from 'hono';
import { inventoryEvents, inventoryLots, users } from '../db/schema';
import { assertHouseholdAccess } from '../lib/access';
import { eventsQuerySchema, parseQuery } from '../lib/validators';
import type { AppEnv } from '../types';

/** /households にマウント */
export const eventsRoute = new Hono<AppEnv>();

/**
 * GET /households/:id/events?from=YYYY-MM-DD&to=YYYY-MM-DD
 * 食品ロス削減量の集計に使う履歴一覧。summary に種別ごとの合計も返す。
 */
eventsRoute.get('/:id/events', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const query = parseQuery(c, eventsQuerySchema);

  const conditions = [eq(inventoryEvents.householdId, householdId)];
  // occurred_at は 'YYYY-MM-DD HH:MM:SS' なので日付境界で文字列比較する
  if (query.from) {
    conditions.push(gte(inventoryEvents.occurredAt, `${query.from} 00:00:00`));
  }
  if (query.to) {
    conditions.push(lte(inventoryEvents.occurredAt, `${query.to} 23:59:59`));
  }
  if (query.event_type) {
    conditions.push(eq(inventoryEvents.eventType, query.event_type));
  }
  const where = and(...conditions);

  const events = await db
    .select({
      id: inventoryEvents.id,
      inventory_lot_id: inventoryEvents.inventoryLotId,
      household_id: inventoryEvents.householdId,
      event_type: inventoryEvents.eventType,
      quantity: inventoryEvents.quantity,
      actor_user_id: inventoryEvents.actorUserId,
      note: inventoryEvents.note,
      occurred_at: inventoryEvents.occurredAt,
      display_name: inventoryLots.displayName,
      unit: inventoryLots.unit,
      actor_display_name: users.displayName,
    })
    .from(inventoryEvents)
    .innerJoin(inventoryLots, eq(inventoryEvents.inventoryLotId, inventoryLots.id))
    .innerJoin(users, eq(inventoryEvents.actorUserId, users.id))
    .where(where)
    .orderBy(desc(inventoryEvents.occurredAt))
    .limit(query.limit)
    .offset(query.offset);

  // 種別ごとの件数・数量合計（食品ロス削減量の集計用）
  const grouped = await db
    .select({
      event_type: inventoryEvents.eventType,
      event_count: count(),
      total_quantity: sum(inventoryEvents.quantity),
    })
    .from(inventoryEvents)
    .where(where)
    .groupBy(inventoryEvents.eventType)
    .orderBy(asc(inventoryEvents.eventType));

  const summary = {
    created: emptyBucket(),
    adjusted: emptyBucket(),
    consumed: emptyBucket(),
    discarded: emptyBucket(),
  };
  for (const row of grouped) {
    summary[row.event_type] = {
      event_count: Number(row.event_count ?? 0),
      total_quantity: Number(row.total_quantity ?? 0),
    };
  }

  // 「消費できた割合」= consumed / (consumed + discarded)
  const consumed = summary.consumed.total_quantity;
  const discarded = summary.discarded.total_quantity;
  const denominator = consumed + discarded;

  return c.json({
    events,
    count: events.length,
    summary,
    loss_stats: {
      consumed_quantity: consumed,
      discarded_quantity: discarded,
      /** 単位が混在するため参考値。UIでは単位別集計と併せて使う想定。 */
      consumption_rate:
        denominator > 0 ? Math.round((consumed / denominator) * 1000) / 1000 : null,
    },
    range: { from: query.from ?? null, to: query.to ?? null },
  });
});

/** GET /households/:id/events/daily — 日別集計（グラフ用） */
eventsRoute.get('/:id/events/daily', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const query = parseQuery(c, eventsQuerySchema);

  const conditions = [eq(inventoryEvents.householdId, householdId)];
  if (query.from) {
    conditions.push(gte(inventoryEvents.occurredAt, `${query.from} 00:00:00`));
  }
  if (query.to) {
    conditions.push(lte(inventoryEvents.occurredAt, `${query.to} 23:59:59`));
  }

  const day = sql<string>`substr(${inventoryEvents.occurredAt}, 1, 10)`;

  const rows = await db
    .select({
      date: day,
      event_type: inventoryEvents.eventType,
      event_count: count(),
      total_quantity: sum(inventoryEvents.quantity),
    })
    .from(inventoryEvents)
    .where(and(...conditions))
    .groupBy(day, inventoryEvents.eventType)
    .orderBy(asc(day));

  return c.json({
    daily: rows.map((r) => ({
      date: r.date,
      event_type: r.event_type,
      event_count: Number(r.event_count ?? 0),
      total_quantity: Number(r.total_quantity ?? 0),
    })),
  });
});

function emptyBucket() {
  return { event_count: 0, total_quantity: 0 };
}
