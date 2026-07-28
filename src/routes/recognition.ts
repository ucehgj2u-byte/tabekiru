import { asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { recognitionCandidates, recognitionJobs } from '../db/schema';
import {
  loadCandidateForUser,
  loadJobForUser,
  loadPhotoForUser,
} from '../lib/access';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/id';
import {
  confirmCandidateSchema,
  parseJsonBody,
  patchCandidateSchema,
} from '../lib/validators';
import { createLot } from '../services/inventoryService';
import { runRecognitionJob } from '../services/recognitionService';
import type { AppEnv } from '../types';

/** /photos にマウント（POST /photos/:id/recognize） */
export const photoRecognizeRoute = new Hono<AppEnv>();

/** /recognition-jobs にマウント */
export const recognitionJobsRoute = new Hono<AppEnv>();

/** /recognition-candidates にマウント */
export const recognitionCandidatesRoute = new Hono<AppEnv>();

/** POST /photos/:id/recognize — ジョブを作成し、画像認識を非同期で起動する */
photoRecognizeRoute.post('/:id/recognize', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const photo = await loadPhotoForUser(db, c.req.param('id'), user.id);

  const jobId = newId('job');
  await db.insert(recognitionJobs).values({
    id: jobId,
    photoId: photo.id,
    status: 'pending',
  });

  // レスポンスを返した後もWorkerを生かしてジョブを完了させる
  const task = runRecognitionJob(db, c.env, jobId, photo.id);
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(task);
  } else {
    await task;
  }

  const job = await db
    .select()
    .from(recognitionJobs)
    .where(eq(recognitionJobs.id, jobId))
    .limit(1);

  return c.json({ recognition_job: job[0] }, 202);
});

/** GET /photos/:id/recognition-jobs — この写真のジョブ一覧 */
photoRecognizeRoute.get('/:id/recognition-jobs', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const photo = await loadPhotoForUser(db, c.req.param('id'), user.id);

  const jobs = await db
    .select()
    .from(recognitionJobs)
    .where(eq(recognitionJobs.photoId, photo.id))
    .orderBy(desc(recognitionJobs.startedAt));

  return c.json({ recognition_jobs: jobs });
});

/** GET /recognition-jobs/:id — ステータス確認 */
recognitionJobsRoute.get('/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { job, photo } = await loadJobForUser(db, c.req.param('id'), user.id);
  return c.json({ recognition_job: job, photo_id: photo.id });
});

/** GET /recognition-jobs/:id/candidates — 検出候補一覧 */
recognitionJobsRoute.get('/:id/candidates', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { job } = await loadJobForUser(db, c.req.param('id'), user.id);

  const candidates = await db
    .select()
    .from(recognitionCandidates)
    .where(eq(recognitionCandidates.jobId, job.id))
    .orderBy(desc(recognitionCandidates.confidence), asc(recognitionCandidates.detectedName));

  return c.json({
    job_status: job.status,
    error_message: job.errorMessage,
    candidates,
  });
});

/** PATCH /recognition-candidates/:id — 候補の修正 */
recognitionCandidatesRoute.patch('/:id', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { candidate } = await loadCandidateForUser(db, c.req.param('id'), user.id);

  if (candidate.status === 'accepted') {
    throw ApiError.conflict('確定済みの候補は修正できません');
  }

  const body = await parseJsonBody(c, patchCandidateSchema);

  await db
    .update(recognitionCandidates)
    .set({
      ...(body.corrected_name !== undefined
        ? { correctedName: body.corrected_name }
        : {}),
      ...(body.suggested_quantity !== undefined
        ? { suggestedQuantity: body.suggested_quantity }
        : {}),
      ...(body.suggested_unit !== undefined
        ? { suggestedUnit: body.suggested_unit }
        : {}),
      ...(body.suggested_category !== undefined
        ? { suggestedCategory: body.suggested_category }
        : {}),
      ...(body.suggested_expires_on !== undefined
        ? { suggestedExpiresOn: body.suggested_expires_on, expirySource: null }
        : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    })
    .where(eq(recognitionCandidates.id, candidate.id));

  const updated = await db
    .select()
    .from(recognitionCandidates)
    .where(eq(recognitionCandidates.id, candidate.id))
    .limit(1);

  return c.json({ candidate: updated[0] });
});

/** POST /recognition-candidates/:id/confirm — 候補を確定して在庫に登録 */
recognitionCandidatesRoute.post('/:id/confirm', async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const { candidate, photo } = await loadCandidateForUser(
    db,
    c.req.param('id'),
    user.id,
  );

  if (candidate.status === 'accepted') {
    throw ApiError.conflict('この候補は既に在庫に登録済みです');
  }
  if (candidate.status === 'rejected') {
    throw ApiError.conflict('却下済みの候補は確定できません');
  }

  const body = await parseJsonBody(c, confirmCandidateSchema);

  // 期限は「指定値 → AIが読み取り/推定した値」の順に採用する
  const expiresOn = body.expires_on ?? candidate.suggestedExpiresOn;
  if (!expiresOn) {
    throw ApiError.badRequest(
      'expires_on を指定してください（この候補にはAIによる期限の推定値がありません）',
    );
  }

  const lot = await createLot(db, {
    householdId: photo.householdId,
    addedBy: user.id,
    displayName:
      body.display_name ?? candidate.correctedName ?? candidate.detectedName,
    category: body.category ?? candidate.suggestedCategory ?? null,
    quantity: body.quantity ?? candidate.suggestedQuantity ?? 1,
    unit: body.unit ?? candidate.suggestedUnit ?? '個',
    expiresOn,
    purchasedOn: body.purchased_on ?? null,
    locationId: body.location_id ?? null,
    foodCatalogId: body.food_catalog_id ?? null,
    source: 'scan',
    photoId: photo.id,
    note: body.note ?? null,
  });

  await db
    .update(recognitionCandidates)
    .set({ status: 'accepted', inventoryLotId: lot.id })
    .where(eq(recognitionCandidates.id, candidate.id));

  const updated = await db
    .select()
    .from(recognitionCandidates)
    .where(eq(recognitionCandidates.id, candidate.id))
    .limit(1);

  return c.json({ inventory_lot: lot, candidate: updated[0] }, 201);
});
