import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { storageLocations } from '../db/schema';
import { assertHouseholdAccess } from '../lib/access';
import { newId } from '../lib/id';
import { createStorageLocationSchema, parseJsonBody } from '../lib/validators';
import type { AppEnv } from '../types';

/** /households/:id 配下にマウントされる。 */
export const storageLocationsRoute = new Hono<AppEnv>();

/** GET /households/:id/storage-locations */
storageLocationsRoute.get('/:id/storage-locations', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const rows = await db
    .select()
    .from(storageLocations)
    .where(eq(storageLocations.householdId, householdId))
    .orderBy(asc(storageLocations.sortOrder), asc(storageLocations.name));

  return c.json({ storage_locations: rows });
});

/** POST /households/:id/storage-locations */
storageLocationsRoute.post('/:id/storage-locations', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');
  await assertHouseholdAccess(db, householdId, user.id);

  const body = await parseJsonBody(c, createStorageLocationSchema);

  const id = newId('loc');
  await db.insert(storageLocations).values({
    id,
    householdId,
    name: body.name,
    type: body.type,
    ...(body.sort_order !== undefined ? { sortOrder: body.sort_order } : {}),
  });

  const created = await db
    .select()
    .from(storageLocations)
    .where(eq(storageLocations.id, id))
    .limit(1);

  return c.json({ storage_location: created[0] }, 201);
});
