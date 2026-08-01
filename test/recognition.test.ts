import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveSuggestedExpiry } from '../src/services/recognitionService';
import {
  api,
  apiJson,
  createHousehold,
  dayFromToday,
  geminiJsonResponse,
  jsonBody,
  tinyPngBytes,
} from './helpers';

describe('resolveSuggestedExpiry（単体）', () => {
  const today = '2026-08-01';

  it('印字の日付には安全係数を掛けない', () => {
    const r = resolveSuggestedExpiry(
      { detected_name: '牛乳', confidence: 0.9, printed_expiry_date: '2026-08-20' },
      today,
    );
    expect(r).toEqual({ date: '2026-08-20', source: 'printed' });
  });

  it('推定日数には0.8倍(floor)を適用する', () => {
    const r = resolveSuggestedExpiry(
      { detected_name: 'にんじん', confidence: 0.9, estimated_shelf_life_days: 21 },
      today,
    );
    // floor(21 * 0.8) = 16日後
    expect(r).toEqual({ date: '2026-08-17', source: 'estimated' });
  });

  it('係数を掛けて0日以下になっても最低1日は確保する', () => {
    const r = resolveSuggestedExpiry(
      { detected_name: 'もやし', confidence: 0.9, estimated_shelf_life_days: 1 },
      today,
    );
    expect(r).toEqual({ date: '2026-08-02', source: 'estimated' });
  });

  it('印字も推定日数も無ければnull', () => {
    const r = resolveSuggestedExpiry(
      { detected_name: '謎の食品', confidence: 0.4 },
      today,
    );
    expect(r).toBeNull();
  });
});

const TOKEN = 'scan-user';
const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

/** モックが受け取ったGeminiリクエスト（URLとボディ）を記録する。 */
let geminiCalls: Array<{ url: string; body: any }> = [];

beforeEach(() => {
  geminiCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * global fetch を差し替えて Gemini API をモックする。
 * （vitest-pool-workers 0.18 で fetchMock が廃止されたため vi.stubGlobal を使う）
 */
function stubGemini(
  responder: (call: { url: string; body: any }) => {
    status?: number;
    json: unknown;
  },
) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith(GEMINI_ORIGIN)) {
      throw new Error(`想定外の外部リクエスト: ${url}`);
    }
    const body = init?.body ? JSON.parse(init.body as string) : null;
    geminiCalls.push({ url, body });

    const { status = 200, json } = responder({ url, body });
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** 成功レスポンス（JSONモードのpayload）を返すモック。 */
function mockGemini(payload: unknown, status = 200) {
  stubGemini(() =>
    status === 200
      ? { json: geminiJsonResponse(payload) }
      : { status, json: payload },
  );
}

async function uploadPhoto(householdId: string) {
  const form = new FormData();
  form.append(
    'file',
    new File([tinyPngBytes()], 'fridge.png', { type: 'image/png' }),
  );

  const res = await api(`/households/${householdId}/photos`, {
    method: 'POST',
    body: form,
    token: TOKEN,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as any;
}

describe('photos', () => {
  let householdId: string;

  beforeEach(async () => {
    householdId = await createHousehold(TOKEN, '撮影テスト家族');
  });

  it('画像をアップロードするとR2に保存されphotosが作られる', async () => {
    const body = await uploadPhoto(householdId);

    expect(body.photo.mime_type).toBe('image/png');
    expect(body.photo.status).toBe('uploaded');
    expect(body.photo.r2_key).toContain(householdId);
    expect(body.size_bytes).toBeGreaterThan(0);
    expect(body.content_url).toContain('signature=');
  });

  it('署名付きURLで画像本体を取得できる（認証ヘッダ不要）', async () => {
    const body = await uploadPhoto(householdId);

    const res = await api(body.content_url, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await res.arrayBuffer()).byteLength).toBe(tinyPngBytes().length);
  });

  it('署名が無く認証も無ければ401', async () => {
    const body = await uploadPhoto(householdId);
    const res = await api(`/photos/${body.photo.id}/content`, { token: null });
    expect(res.status).toBe(401);
  });

  it('署名が改竄されていれば認証にフォールバックし、他人なら403', async () => {
    const body = await uploadPhoto(householdId);
    const tampered = body.content_url.replace(/signature=\w+/, 'signature=deadbeef');
    const res = await api(tampered, { token: 'not-a-member' });
    expect(res.status).toBe(403);
  });

  it('multipartでないと400', async () => {
    const { status } = await apiJson(`/households/${householdId}/photos`, {
      method: 'POST',
      body: jsonBody({ file: 'x' }),
      token: TOKEN,
    });
    expect(status).toBe(400);
  });

  it('MIMEが空でも拡張子から画像形式を判定する', async () => {
    // 一部のブラウザ/OSでは file.type が空や octet-stream になる
    const form = new FormData();
    form.append(
      'file',
      new File([tinyPngBytes()], 'fridge.png', { type: 'application/octet-stream' }),
    );
    const res = await api(`/households/${householdId}/photos`, {
      method: 'POST',
      body: form,
      token: TOKEN,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).photo.mime_type).toBe('image/png');
  });

  it('画像以外のMIMEは422', async () => {
    const form = new FormData();
    form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    const res = await api(`/households/${householdId}/photos`, {
      method: 'POST',
      body: form,
      token: TOKEN,
    });
    expect(res.status).toBe(422);
  });
});

describe('賞味期限スキャン（期限撮影用カメラ）', () => {
  let householdId: string;

  beforeEach(async () => {
    householdId = await createHousehold(TOKEN, '期限スキャン家族');
  });

  async function postExpiry() {
    const form = new FormData();
    form.append(
      'file',
      new File([tinyPngBytes()], 'expiry.png', { type: 'image/png' }),
    );
    const res = await api(`/households/${householdId}/expiry-scan`, {
      method: 'POST',
      body: form,
      token: TOKEN,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('印字を読み取って日付を返す', async () => {
    mockGemini({ expires_on: '2026-09-14', raw_text: '26.09.14', confidence: 0.97 });

    const { status, body } = await postExpiry();
    expect(status).toBe(200);
    expect(body.expires_on).toBe('2026-09-14');
    expect(body.raw_text).toBe('26.09.14');
    expect(body.model_name).toBe('gemini-3-flash-preview');
  });

  it('画像はR2にもDBにも保存されない（読んだら破棄）', async () => {
    mockGemini({ expires_on: '2026-09-14', confidence: 0.9 });
    await postExpiry();

    const photos = await apiJson(`/households/${householdId}/photos`, {
      token: TOKEN,
    });
    expect(photos.body.photos).toHaveLength(0);
  });

  it('読み取れない日付は null を返す', async () => {
    mockGemini({ expires_on: '', raw_text: 'よく見えない', confidence: 0.1 });

    const { status, body } = await postExpiry();
    expect(status).toBe(200);
    expect(body.expires_on).toBeNull();
    expect(body.raw_text).toBe('よく見えない');
  });

  it('実在しない日付は採用しない', async () => {
    mockGemini({ expires_on: '2026-02-30', confidence: 0.8 });

    const { body } = await postExpiry();
    expect(body.expires_on).toBeNull();
  });

  it('メンバー以外は403', async () => {
    const form = new FormData();
    form.append('file', new File([tinyPngBytes()], 'e.png', { type: 'image/png' }));
    const res = await api(`/households/${householdId}/expiry-scan`, {
      method: 'POST',
      body: form,
      token: 'outsider',
    });
    expect(res.status).toBe(403);
  });
});

describe('Gemini呼び出しの再試行', () => {
  it('503は1回だけ再試行して成功する', async () => {
    const householdId = await createHousehold(TOKEN, '再試行テスト');

    let calls = 0;
    stubGemini(() => {
      calls++;
      return calls === 1
        ? { status: 503, json: { error: { message: 'overloaded' } } }
        : { json: geminiJsonResponse({ expires_on: '2026-10-01', confidence: 0.9 }) };
    });

    const form = new FormData();
    form.append('file', new File([tinyPngBytes()], 'e.png', { type: 'image/png' }));
    const res = await api(`/households/${householdId}/expiry-scan`, {
      method: 'POST',
      body: form,
      token: TOKEN,
    });

    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).expires_on).toBe('2026-10-01');
  });

  it('429は再試行せず429を返す', async () => {
    const householdId = await createHousehold(TOKEN, 'レート制限テスト2');

    let calls = 0;
    stubGemini(() => {
      calls++;
      return { status: 429, json: { error: { message: 'quota' } } };
    });

    const form = new FormData();
    form.append('file', new File([tinyPngBytes()], 'e.png', { type: 'image/png' }));
    const res = await api(`/households/${householdId}/expiry-scan`, {
      method: 'POST',
      body: form,
      token: TOKEN,
    });

    expect(calls).toBe(1);
    expect(res.status).toBe(429);
  });
});

describe('recognition フロー', () => {
  let householdId: string;

  beforeEach(async () => {
    householdId = await createHousehold(TOKEN, '認識テスト家族');
  });

  it('認識ジョブが完了し候補が登録される', async () => {
    const photo = await uploadPhoto(householdId);

    mockGemini([
      { detected_name: 'にんじん', confidence: 0.92, suggested_quantity: 2, suggested_unit: '本' },
      { detected_name: '牛乳', confidence: 0.41, suggested_quantity: 1, suggested_unit: '本' },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    expect(started.status).toBe(202);
    const jobId = started.body.recognition_job.id;

    const job = await apiJson(`/recognition-jobs/${jobId}`, { token: TOKEN });
    expect(job.body.recognition_job.status).toBe('completed');
    expect(job.body.recognition_job.model_name).toBe('gemini-3-flash-preview');

    const candidates = await apiJson(`/recognition-jobs/${jobId}/candidates`, {
      token: TOKEN,
    });
    expect(candidates.body.candidates).toHaveLength(2);
    // 確信度が高い順
    expect(candidates.body.candidates[0].detected_name).toBe('にんじん');
    // 低確信度もそのまま登録される
    expect(candidates.body.candidates[1].confidence).toBeCloseTo(0.41);
    expect(candidates.body.candidates[0].bounding_box_json).toBeNull();
    expect(candidates.body.candidates[0].status).toBe('pending');
  });

  it('Geminiへは画像をinline_dataで送りJSONスキーマを指定している', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([{ detected_name: 'ねぎ', confidence: 0.7 }]);

    await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });

    expect(geminiCalls).toHaveLength(1);
    const call = geminiCalls[0];
    expect(call.url).toContain('/v1beta/models/gemini-3-flash-preview:generateContent');
    expect(call.url).toContain('key=test-api-key');

    const parts = call.body.contents[0].parts;
    expect(parts[0].text).toContain('食材');
    expect(parts[1].inline_data.mime_type).toBe('image/png');
    expect(parts[1].inline_data.data.length).toBeGreaterThan(0);

    expect(call.body.generationConfig.responseMimeType).toBe('application/json');
    expect(call.body.generationConfig.responseSchema.type).toBe('ARRAY');
    expect(call.body.generationConfig.responseSchema.items.required).toEqual([
      'detected_name',
      'confidence',
    ]);
  });

  it('パッケージの印字を読み取れた場合はその日付が期限候補になる', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      {
        detected_name: '牛乳',
        confidence: 0.95,
        suggested_quantity: 1,
        suggested_unit: '本',
        category: '乳製品',
        printed_expiry_date: '2026-08-15',
        estimated_shelf_life_days: 0,
      },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const c = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );
    const cand = c.body.candidates[0];
    expect(cand.suggested_category).toBe('乳製品');
    expect(cand.suggested_expires_on).toBe('2026-08-15');
    expect(cand.expiry_source).toBe('printed');
  });

  it('印字が無い食材は一般的な日持ちから期限を推定する', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      {
        detected_name: 'にんじん',
        confidence: 0.9,
        category: '野菜',
        printed_expiry_date: '',
        estimated_shelf_life_days: 21,
      },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const c = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );
    const cand = c.body.candidates[0];
    expect(cand.suggested_category).toBe('野菜');
    // 一般的な日持ち(21日)に安全係数0.8を掛けて16日に短縮される
    expect(cand.suggested_expires_on).toBe(dayFromToday(16));
    expect(cand.expiry_source).toBe('estimated');
  });

  it('未知のカテゴリ名は「その他」に寄せられる', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      { detected_name: '謎の食材', confidence: 0.6, category: 'スナック菓子' },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const c = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );
    expect(c.body.candidates[0].suggested_category).toBe('その他');
    // 期限の手掛かりが無ければ null（UIで手入力させる）
    expect(c.body.candidates[0].suggested_expires_on).toBeNull();
  });

  it('expires_onを省略するとAIの推定期限で在庫登録される', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      {
        detected_name: '豆腐',
        confidence: 0.88,
        suggested_quantity: 1,
        suggested_unit: '丁',
        category: '大豆製品',
        estimated_shelf_life_days: 7,
      },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const c = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );

    const confirmed = await apiJson(
      `/recognition-candidates/${c.body.candidates[0].id}/confirm`,
      { method: 'POST', body: jsonBody({}), token: TOKEN },
    );
    expect(confirmed.status).toBe(201);
    // 一般的な日持ち(7日)に安全係数0.8を掛けて5日に短縮される
    expect(confirmed.body.inventory_lot.expires_on).toBe(dayFromToday(5));
    expect(confirmed.body.inventory_lot.category).toBe('大豆製品');
  });

  it('推定期限が無い候補でexpires_onも省略すると400', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([{ detected_name: 'なにか', confidence: 0.5 }]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const c = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );

    const res = await apiJson(
      `/recognition-candidates/${c.body.candidates[0].id}/confirm`,
      { method: 'POST', body: jsonBody({}), token: TOKEN },
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('expires_on');
  });

  it('1枚の写真から検出した複数候補をまとめて確定できる（UIの一括登録が使う経路）', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      { detected_name: 'にんじん', confidence: 0.92, category: '野菜', suggested_quantity: 2, suggested_unit: '本' },
      { detected_name: 'りんご', confidence: 0.88, category: '果物', suggested_quantity: 1, suggested_unit: '個' },
      { detected_name: '卵', confidence: 0.81, category: '卵', suggested_quantity: 6, suggested_unit: '個' },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const jobId = started.body.recognition_job.id;
    const candidates = await apiJson(`/recognition-jobs/${jobId}/candidates`, {
      token: TOKEN,
    });
    expect(candidates.body.candidates).toHaveLength(3);

    // UIのconfirmAllCandidatesは各候補を順にconfirmする。同じ経路をここで検証する。
    const confirmedLots = [];
    for (const cand of candidates.body.candidates) {
      const res = await apiJson(`/recognition-candidates/${cand.id}/confirm`, {
        method: 'POST',
        body: jsonBody({ expires_on: dayFromToday(7) }),
        token: TOKEN,
      });
      expect(res.status).toBe(201);
      confirmedLots.push(res.body.inventory_lot);
    }

    expect(confirmedLots.map((l: any) => l.display_name).sort()).toEqual(
      ['にんじん', 'りんご', '卵'].sort(),
    );
    // 全員が同じ写真から登録されたことになっている
    expect(confirmedLots.every((l: any) => l.photo_id === photo.photo.id)).toBe(true);

    const list = await apiJson(`/households/${householdId}/inventory`, { token: TOKEN });
    expect(list.body.items).toHaveLength(3);

    // 全候補が accepted になっている
    const after = await apiJson(`/recognition-jobs/${jobId}/candidates`, { token: TOKEN });
    expect(after.body.candidates.every((c: any) => c.status === 'accepted')).toBe(true);
  });

  it('一括確定の途中で1件が失敗しても、他の候補は登録できる', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      { detected_name: 'トマト', confidence: 0.9, suggested_quantity: 2, suggested_unit: '個' },
      { detected_name: '謎の食材', confidence: 0.3 },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const candidates = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );

    const tomato = candidates.body.candidates.find((c: any) => c.detected_name === 'トマト');
    const mystery = candidates.body.candidates.find((c: any) => c.detected_name === '謎の食材');

    const ok = await apiJson(`/recognition-candidates/${tomato.id}/confirm`, {
      method: 'POST',
      body: jsonBody({ expires_on: dayFromToday(5) }),
      token: TOKEN,
    });
    expect(ok.status).toBe(201);

    // 期限の手掛かりが無い候補は expires_on 省略だと400（UI側では「まだ登録済みでない」候補として残る）
    const fail = await apiJson(`/recognition-candidates/${mystery.id}/confirm`, {
      method: 'POST',
      body: jsonBody({}),
      token: TOKEN,
    });
    expect(fail.status).toBe(400);

    const list = await apiJson(`/households/${householdId}/inventory`, { token: TOKEN });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].display_name).toBe('トマト');
  });

  it('候補を修正して確定すると在庫とcreatedイベントが作られる', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([
      { detected_name: 'にんじ', confidence: 0.6, suggested_quantity: 2, suggested_unit: '本' },
    ]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const jobId = started.body.recognition_job.id;
    const candidates = await apiJson(`/recognition-jobs/${jobId}/candidates`, {
      token: TOKEN,
    });
    const candidateId = candidates.body.candidates[0].id;

    const patched = await apiJson(`/recognition-candidates/${candidateId}`, {
      method: 'PATCH',
      body: jsonBody({ corrected_name: 'にんじん', suggested_quantity: 3 }),
      token: TOKEN,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.candidate.corrected_name).toBe('にんじん');

    const confirmed = await apiJson(
      `/recognition-candidates/${candidateId}/confirm`,
      {
        method: 'POST',
        body: jsonBody({ expires_on: dayFromToday(4) }),
        token: TOKEN,
      },
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.inventory_lot.display_name).toBe('にんじん');
    expect(confirmed.body.inventory_lot.quantity).toBe(3);
    expect(confirmed.body.inventory_lot.source).toBe('scan');
    expect(confirmed.body.inventory_lot.photo_id).toBe(photo.photo.id);
    expect(confirmed.body.candidate.status).toBe('accepted');

    const events = await apiJson(
      `/inventory/${confirmed.body.inventory_lot.id}/events`,
      { token: TOKEN },
    );
    expect(events.body.events[0].event_type).toBe('created');

    // 在庫一覧にも出る。カード表示用に署名付きの写真URLが付く。
    const list = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].photo_url).toContain(`/photos/${photo.photo.id}/content`);
    expect(list.body.items[0].photo_url).toContain('signature=');

    // その署名付きURLで画像が実際に取得できる
    const image = await api(list.body.items[0].photo_url, { token: null });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
  });

  it('手入力（写真なし）の在庫は photo_url が null', async () => {
    const created = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: '鮭',
        quantity: 2,
        unit: '切れ',
        expires_on: dayFromToday(3),
      }),
      token: TOKEN,
    });
    expect(created.status).toBe(201);

    const list = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(list.body.items[0].photo_url).toBeNull();
  });

  it('確定済みの候補は再確定できない', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([{ detected_name: 'トマト', confidence: 0.9 }]);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const candidates = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}/candidates`,
      { token: TOKEN },
    );
    const candidateId = candidates.body.candidates[0].id;

    await apiJson(`/recognition-candidates/${candidateId}/confirm`, {
      method: 'POST',
      body: jsonBody({ expires_on: dayFromToday(3) }),
      token: TOKEN,
    });

    const second = await apiJson(`/recognition-candidates/${candidateId}/confirm`, {
      method: 'POST',
      body: jsonBody({ expires_on: dayFromToday(3) }),
      token: TOKEN,
    });
    expect(second.status).toBe(409);
  });

  it('Geminiが429を返すとジョブがfailedになりレート制限が記録される', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini({ error: { message: 'Quota exceeded' } }, 429);

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const job = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}`,
      { token: TOKEN },
    );
    expect(job.body.recognition_job.status).toBe('failed');
    expect(job.body.recognition_job.error_message).toContain('rate_limited');
    expect(job.body.recognition_job.error_message).toContain('429');
  });

  it('JSONとして壊れたレスポンスはリトライせずfailedになる', async () => {
    const photo = await uploadPhoto(householdId);
    stubGemini(() => ({
      json: {
        candidates: [{ content: { parts: [{ text: 'これはJSONではありません' }] } }],
      },
    }));

    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });
    const job = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}`,
      { token: TOKEN },
    );
    expect(job.body.recognition_job.status).toBe('failed');
    expect(job.body.recognition_job.error_message).toContain('invalid_json');
  });

  it('他householdのユーザーは認識ジョブを参照できない', async () => {
    const photo = await uploadPhoto(householdId);
    mockGemini([{ detected_name: 'なす', confidence: 0.8 }]);
    const started = await apiJson(`/photos/${photo.photo.id}/recognize`, {
      method: 'POST',
      token: TOKEN,
    });

    const { status } = await apiJson(
      `/recognition-jobs/${started.body.recognition_job.id}`,
      { token: 'outsider' },
    );
    expect(status).toBe(403);
  });
});

describe('recipes 提案', () => {
  it('GET /recipes/suggestions（自動選択）は廃止されている', async () => {
    const householdId = await createHousehold(TOKEN, '廃止確認家族');
    const { status } = await apiJson(`/households/${householdId}/recipes/suggestions`, {
      token: TOKEN,
    });
    // ルートが存在しないため 404（Geminiは一切呼ばれない）
    expect(status).toBe(404);
    expect(geminiCalls).toHaveLength(0);
  });

  it('inventory_lot_idsを渡さないと提案できない（自動選択は無い）', async () => {
    const householdId = await createHousehold(TOKEN, '選択必須家族');
    await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'ほうれん草',
        quantity: 1,
        unit: '束',
        expires_on: dayFromToday(2),
      }),
      token: TOKEN,
    });

    const { status } = await apiJson(`/households/${householdId}/recipes/suggestions`, {
      method: 'POST',
      body: jsonBody({}),
      token: TOKEN,
    });
    expect(status).toBe(400);
    expect(geminiCalls).toHaveLength(0);
  });

  it('選んだ食材でレシピを返す（期限順にプロンプトへ渡る）', async () => {
    const householdId = await createHousehold(TOKEN, 'レシピテスト家族');
    const lotIds: string[] = [];
    for (const [name, days] of [
      ['にんじん', 2],
      ['牛乳', 1],
    ] as const) {
      const r = await apiJson(`/households/${householdId}/inventory`, {
        method: 'POST',
        body: jsonBody({
          display_name: name,
          quantity: 1,
          unit: '本',
          expires_on: dayFromToday(days),
        }),
        token: TOKEN,
      });
      lotIds.push(r.body.inventory_lot.id);
    }

    mockGemini([
      {
        title: 'にんじんのミルクスープ',
        used_ingredients: ['にんじん', '牛乳'],
        steps: ['にんじんを切る', '牛乳で煮る', '塩で味を整える'],
      },
    ]);

    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: lotIds }),
        token: TOKEN,
      },
    );
    expect(status).toBe(200);
    expect(body.recipes).toHaveLength(1);
    expect(body.recipes[0].title).toBe('にんじんのミルクスープ');
    expect(body.recipes[0].steps).toHaveLength(3);
    expect(body.model_name).toBe('gemini-3-flash-preview');
    // 期限が近い順に渡される
    expect(body.based_on[0].display_name).toBe('牛乳');

    // プロンプトに食材リストが期限付きで埋め込まれている
    const prompt = geminiCalls[0].body.contents[0].parts[0].text as string;
    expect(prompt).toContain(`牛乳(期限${dayFromToday(1)}`);
    expect(prompt).toContain(`にんじん(期限${dayFromToday(2)}`);
    expect(prompt.indexOf('牛乳')).toBeLessThan(prompt.indexOf('にんじん'));
    expect(geminiCalls[0].body.contents[0].parts).toHaveLength(1);
  });

  it('レート制限時は429を返す', async () => {
    const householdId = await createHousehold(TOKEN, 'レート制限テスト');
    const lot = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'キャベツ',
        quantity: 1,
        unit: '玉',
        expires_on: dayFromToday(2),
      }),
      token: TOKEN,
    });

    mockGemini({ error: { message: 'Quota exceeded' } }, 429);

    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: [lot.body.inventory_lot.id] }),
        token: TOKEN,
      },
    );
    expect(status).toBe(429);
    expect(body.error.code).toBe('gemini_rate_limited');
  });

  it('レシピに不足食材(missing_ingredients)が含まれる', async () => {
    const householdId = await createHousehold(TOKEN, '不足食材テスト');
    const lot = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'キャベツ',
        quantity: 1,
        unit: '玉',
        expires_on: dayFromToday(3),
      }),
      token: TOKEN,
    });

    mockGemini([
      {
        title: 'キャベツと豚肉の炒め物',
        used_ingredients: ['キャベツ'],
        steps: ['切る', '炒める'],
        missing_ingredients: ['豚肉', 'ごま油'],
      },
    ]);

    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: [lot.body.inventory_lot.id] }),
        token: TOKEN,
      },
    );
    expect(status).toBe(200);
    expect(body.recipes[0].missing_ingredients).toEqual(['豚肉', 'ごま油']);
  });

  it('missing_ingredientsが無い場合は空配列になる', async () => {
    const householdId = await createHousehold(TOKEN, '不足食材なしテスト');
    const lot = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'りんご',
        quantity: 1,
        unit: '個',
        expires_on: dayFromToday(3),
      }),
      token: TOKEN,
    });

    mockGemini([
      { title: 'りんごだけで完成', used_ingredients: ['りんご'], steps: ['切る'] },
    ]);

    const { body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: [lot.body.inventory_lot.id] }),
        token: TOKEN,
      },
    );
    expect(body.recipes[0].missing_ingredients).toEqual([]);
  });

  it('提案が成功すると履歴として保存され、selection_modeはselectedになる', async () => {
    const householdId = await createHousehold(TOKEN, '履歴テスト家族');
    const lot = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'なす',
        quantity: 2,
        unit: '本',
        expires_on: dayFromToday(3),
      }),
      token: TOKEN,
    });

    mockGemini([
      {
        title: 'なすの味噌炒め',
        used_ingredients: ['なす'],
        steps: ['切る', '炒める', '味噌で味付け'],
        missing_ingredients: ['味噌'],
      },
    ]);

    const suggestion = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: [lot.body.inventory_lot.id] }),
        token: TOKEN,
      },
    );
    expect(suggestion.status).toBe(200);

    const history = await apiJson(`/households/${householdId}/recipes/history`, {
      token: TOKEN,
    });
    expect(history.status).toBe(200);
    expect(history.body.history).toHaveLength(1);
    const entry = history.body.history[0];
    expect(entry.model_name).toBe('gemini-3-flash-preview');
    expect(entry.selection_mode).toBe('selected');
    expect(entry.recipes[0].title).toBe('なすの味噌炒め');
    expect(entry.recipes[0].missing_ingredients).toEqual(['味噌']);
    expect(entry.based_on[0].display_name).toBe('なす');
    expect(entry.created_at).toBeDefined();
  });

  it('履歴は新しい順に並び、他householdのものは見えない', async () => {
    const householdId = await createHousehold(TOKEN, '順序履歴テスト');
    const otherHouseholdId = await createHousehold('other-history-user', '他人の履歴家');

    const daikon = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: '大根', quantity: 1, unit: '本', expires_on: dayFromToday(5),
      }),
      token: TOKEN,
    });
    const negi = await apiJson(`/households/${otherHouseholdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'ネギ', quantity: 1, unit: '本', expires_on: dayFromToday(5),
      }),
      token: 'other-history-user',
    });
    const daikonId = daikon.body.inventory_lot.id;
    const negiId = negi.body.inventory_lot.id;

    mockGemini([{ title: '大根の煮物', used_ingredients: ['大根'], steps: ['煮る'] }]);
    await apiJson(`/households/${householdId}/recipes/suggestions`, {
      method: 'POST',
      body: jsonBody({ inventory_lot_ids: [daikonId] }),
      token: TOKEN,
    });

    mockGemini([{ title: 'ネギ味噌', used_ingredients: ['ネギ'], steps: ['刻む'] }]);
    await apiJson(`/households/${otherHouseholdId}/recipes/suggestions`, {
      method: 'POST',
      body: jsonBody({ inventory_lot_ids: [negiId] }),
      token: 'other-history-user',
    });

    mockGemini([{ title: '大根サラダ', used_ingredients: ['大根'], steps: ['和える'] }]);
    await apiJson(`/households/${householdId}/recipes/suggestions`, {
      method: 'POST',
      body: jsonBody({ inventory_lot_ids: [daikonId] }),
      token: TOKEN,
    });

    const history = await apiJson(`/households/${householdId}/recipes/history`, {
      token: TOKEN,
    });
    expect(history.body.history).toHaveLength(2);
    // 新しい順
    expect(history.body.history[0].recipes[0].title).toBe('大根サラダ');
    expect(history.body.history[1].recipes[0].title).toBe('大根の煮物');
  });

  it('POSTで選んだ食材だけをGeminiに渡す', async () => {
    const householdId = await createHousehold(TOKEN, '選択レシピテスト');
    const lotIds: Record<string, string> = {};
    for (const [name, days] of [
      ['にんじん', 2],
      ['牛乳', 1],
      ['キャベツ', 5],
    ] as const) {
      const r = await apiJson(`/households/${householdId}/inventory`, {
        method: 'POST',
        body: jsonBody({
          display_name: name,
          quantity: 1,
          unit: '個',
          expires_on: dayFromToday(days),
        }),
        token: TOKEN,
      });
      lotIds[name] = r.body.inventory_lot.id;
    }

    mockGemini([
      {
        title: 'にんじんとキャベツの炒め物',
        used_ingredients: ['にんじん', 'キャベツ'],
        steps: ['切る', '炒める', '味付けする'],
      },
    ]);

    // 牛乳は選ばず、にんじん・キャベツだけ選択する
    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({
          inventory_lot_ids: [lotIds['にんじん'], lotIds['キャベツ']],
        }),
        token: TOKEN,
      },
    );
    expect(status).toBe(200);
    expect(body.based_on.map((b: any) => b.display_name).sort()).toEqual([
      'にんじん',
      'キャベツ',
    ]);

    const prompt = geminiCalls[0].body.contents[0].parts[0].text as string;
    expect(prompt).toContain('にんじん');
    expect(prompt).toContain('キャベツ');
    expect(prompt).not.toContain('牛乳');
  });

  it('他householdの在庫IDを混ぜても無視される', async () => {
    const householdId = await createHousehold(TOKEN, '選択レシピ自宅');
    const otherHouseholdId = await createHousehold('other-recipe-user', '他人の家');

    const mine = await apiJson(`/households/${householdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: 'トマト',
        quantity: 1,
        unit: '個',
        expires_on: dayFromToday(3),
      }),
      token: TOKEN,
    });
    const theirs = await apiJson(`/households/${otherHouseholdId}/inventory`, {
      method: 'POST',
      body: jsonBody({
        display_name: '豚肉',
        quantity: 1,
        unit: 'パック',
        expires_on: dayFromToday(3),
      }),
      token: 'other-recipe-user',
    });

    mockGemini([{ title: 'トマト炒め', used_ingredients: ['トマト'], steps: ['炒める'] }]);

    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({
          inventory_lot_ids: [
            mine.body.inventory_lot.id,
            theirs.body.inventory_lot.id,
          ],
        }),
        token: TOKEN,
      },
    );
    expect(status).toBe(200);
    expect(body.based_on).toHaveLength(1);
    expect(body.based_on[0].display_name).toBe('トマト');
  });

  it('選択した在庫が消費済み等で見つからない場合は400', async () => {
    const householdId = await createHousehold(TOKEN, '選択レシピ空撃ち');
    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: ['lot_does_not_exist'] }),
        token: TOKEN,
      },
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad_request');
  });

  it('inventory_lot_idsが空配列だと400', async () => {
    const householdId = await createHousehold(TOKEN, '選択レシピ空配列');
    const { status } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      {
        method: 'POST',
        body: jsonBody({ inventory_lot_ids: [] }),
        token: TOKEN,
      },
    );
    expect(status).toBe(400);
  });
});
