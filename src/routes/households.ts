import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { householdMembers, households, users } from '../db/schema';
import { assertHouseholdAccess, assertOwner } from '../lib/access';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import { addMemberSchema, createHouseholdSchema, parseJsonBody } from '../lib/validators';
import { getOrCreateUser } from '../middleware/auth';
import type { AppEnv } from '../types';

export const householdsRoute = new Hono<AppEnv>();

/** GET /households — リクエストユーザーが所属するhousehold一覧（UIの家庭切り替え用） */
householdsRoute.get('/', async (c) => {
  const db = c.get('db');
  const user = c.get('user');

  const rows = await db
    .select({
      id: households.id,
      name: households.name,
      owner_user_id: households.ownerUserId,
      timezone: households.timezone,
      created_at: households.createdAt,
      role: householdMembers.role,
      member_status: householdMembers.status,
    })
    .from(householdMembers)
    .innerJoin(households, eq(householdMembers.householdId, households.id))
    .where(eq(householdMembers.userId, user.id))
    .orderBy(households.createdAt);

  return c.json({ households: rows });
});

/** POST /households — household作成（作成者をownerとしてmembersに自動追加） */
householdsRoute.post('/', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const body = await parseJsonBody(c, createHouseholdSchema);

  const householdId = newId('hh');
  await db.insert(households).values({
    id: householdId,
    name: body.name,
    ownerUserId: user.id,
    ...(body.timezone ? { timezone: body.timezone } : {}),
  });

  await db.insert(householdMembers).values({
    householdId,
    userId: user.id,
    role: 'owner',
    status: 'active',
  });

  const created = await db
    .select()
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);

  return c.json({ household: created[0] }, 201);
});

/** GET /households/:id — 詳細取得（メンバー一覧付き） */
householdsRoute.get('/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');

  const { household } = await assertHouseholdAccess(db, householdId, user.id);

  const members = await db
    .select({
      user_id: householdMembers.userId,
      role: householdMembers.role,
      status: householdMembers.status,
      joined_at: householdMembers.joinedAt,
      display_name: users.displayName,
      email: users.email,
    })
    .from(householdMembers)
    .innerJoin(users, eq(householdMembers.userId, users.id))
    .where(eq(householdMembers.householdId, householdId));

  return c.json({ household, members });
});

/** POST /households/:id/members — メンバー招待/追加（ownerのみ） */
householdsRoute.post('/:id/members', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const householdId = c.req.param('id');

  const { member } = await assertHouseholdAccess(db, householdId, user.id);
  assertOwner(member);

  const body = await parseJsonBody(c, addMemberSchema);

  // user_id 指定なら既存ユーザー、email 指定なら既存ユーザーを検索し、
  // 見つからなければ招待用のユーザーレコードを作る。
  let targetUserId: string;
  if (body.user_id) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, body.user_id))
      .limit(1);
    if (rows.length === 0) {
      throw ApiError.notFound('指定されたuser_idのユーザーが見つかりません');
    }
    targetUserId = rows[0].id;
  } else {
    const email = body.email!;
    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (rows.length > 0) {
      targetUserId = rows[0].id;
    } else {
      // 未登録ユーザーの招待。auth_user_id は招待用の仮の値にしておき、
      // 本人がこのトークンでログインした時点で実ユーザーとして使われる。
      const invited = await getOrCreateUser(db, `invite:${email}`, {
        email,
        displayName: body.display_name ?? email.split('@')[0],
      });
      targetUserId = invited.id;
    }
  }

  const existing = await db
    .select()
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        eq(householdMembers.userId, targetUserId),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw ApiError.conflict('このユーザーは既にhouseholdのメンバーです');
  }

  await db.insert(householdMembers).values({
    householdId,
    userId: targetUserId,
    role: body.role,
    status: body.status,
  });

  const created = await db
    .select({
      household_id: householdMembers.householdId,
      user_id: householdMembers.userId,
      role: householdMembers.role,
      status: householdMembers.status,
      joined_at: householdMembers.joinedAt,
      display_name: users.displayName,
      email: users.email,
    })
    .from(householdMembers)
    .innerJoin(users, eq(householdMembers.userId, users.id))
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        eq(householdMembers.userId, targetUserId),
      ),
    )
    .limit(1);

  return c.json({ member: created[0] }, 201);
});
