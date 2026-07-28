import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  householdMembers,
  households,
  inventoryLots,
  photos,
  recognitionCandidates,
  recognitionJobs,
  type Household,
  type HouseholdMember,
  type InventoryLot,
  type Photo,
  type RecognitionCandidate,
  type RecognitionJob,
} from '../db/schema';
import { ApiError } from './errors';

/**
 * household配下のリソースへのアクセス制御。
 * 「リクエストユーザーがそのhouseholdのactiveメンバーか」を必ず通してから
 * データを返す。
 */

export async function getHouseholdOr404(
  db: Db,
  householdId: string,
): Promise<Household> {
  const rows = await db
    .select()
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('householdが見つかりません');
  }
  return rows[0];
}

/** activeメンバーであることを検証し、メンバーシップを返す。 */
export async function assertMember(
  db: Db,
  householdId: string,
  userId: string,
): Promise<HouseholdMember> {
  const rows = await db
    .select()
    .from(householdMembers)
    .where(
      and(
        eq(householdMembers.householdId, householdId),
        eq(householdMembers.userId, userId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    // householdの存在有無を漏らさないよう、存在確認をしてからメッセージを変える
    await getHouseholdOr404(db, householdId);
    throw ApiError.forbidden('このhouseholdのメンバーではありません');
  }

  const member = rows[0];
  if (member.status !== 'active') {
    throw ApiError.forbidden(
      '招待中(invited)のため、まだこのhouseholdのデータにアクセスできません',
    );
  }
  return member;
}

/** householdの存在確認 + activeメンバー確認をまとめて行う。 */
export async function assertHouseholdAccess(
  db: Db,
  householdId: string,
  userId: string,
): Promise<{ household: Household; member: HouseholdMember }> {
  const household = await getHouseholdOr404(db, householdId);
  const member = await assertMember(db, householdId, userId);
  return { household, member };
}

/** ownerのみが許される操作で使う。 */
export function assertOwner(member: HouseholdMember): void {
  if (member.role !== 'owner') {
    throw ApiError.forbidden('この操作はhouseholdのownerのみ実行できます');
  }
}

export async function loadLotForUser(
  db: Db,
  lotId: string,
  userId: string,
): Promise<InventoryLot> {
  const rows = await db
    .select()
    .from(inventoryLots)
    .where(eq(inventoryLots.id, lotId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('在庫(inventory_lot)が見つかりません');
  }
  await assertMember(db, rows[0].householdId, userId);
  return rows[0];
}

export async function loadPhotoForUser(
  db: Db,
  photoId: string,
  userId: string,
): Promise<Photo> {
  const rows = await db
    .select()
    .from(photos)
    .where(eq(photos.id, photoId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('写真が見つかりません');
  }
  await assertMember(db, rows[0].householdId, userId);
  return rows[0];
}

export async function loadJobForUser(
  db: Db,
  jobId: string,
  userId: string,
): Promise<{ job: RecognitionJob; photo: Photo }> {
  const rows = await db
    .select({ job: recognitionJobs, photo: photos })
    .from(recognitionJobs)
    .innerJoin(photos, eq(recognitionJobs.photoId, photos.id))
    .where(eq(recognitionJobs.id, jobId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('認識ジョブが見つかりません');
  }
  await assertMember(db, rows[0].photo.householdId, userId);
  return rows[0];
}

export async function loadCandidateForUser(
  db: Db,
  candidateId: string,
  userId: string,
): Promise<{
  candidate: RecognitionCandidate;
  job: RecognitionJob;
  photo: Photo;
}> {
  const rows = await db
    .select({
      candidate: recognitionCandidates,
      job: recognitionJobs,
      photo: photos,
    })
    .from(recognitionCandidates)
    .innerJoin(
      recognitionJobs,
      eq(recognitionCandidates.jobId, recognitionJobs.id),
    )
    .innerJoin(photos, eq(recognitionJobs.photoId, photos.id))
    .where(eq(recognitionCandidates.id, candidateId))
    .limit(1);
  if (rows.length === 0) {
    throw ApiError.notFound('認識候補が見つかりません');
  }
  await assertMember(db, rows[0].photo.householdId, userId);
  return rows[0];
}
