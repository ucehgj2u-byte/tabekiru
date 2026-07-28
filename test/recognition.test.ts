import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import {
  api,
  apiJson,
  createHousehold,
  dayFromToday,
  geminiJsonResponse,
  jsonBody,
  tinyPngBytes,
} from './helpers';

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
    expect(cand.suggested_expires_on).toBe(dayFromToday(21));
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
    expect(confirmed.body.inventory_lot.expires_on).toBe(dayFromToday(7));
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

    // 在庫一覧にも出る
    const list = await apiJson(`/households/${householdId}/inventory`, {
      token: TOKEN,
    });
    expect(list.body.items).toHaveLength(1);
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
  it('期限が近い在庫を元にレシピを返す', async () => {
    const householdId = await createHousehold(TOKEN, 'レシピテスト家族');
    for (const [name, days] of [
      ['にんじん', 2],
      ['牛乳', 1],
    ] as const) {
      await apiJson(`/households/${householdId}/inventory`, {
        method: 'POST',
        body: jsonBody({
          display_name: name,
          quantity: 1,
          unit: '本',
          expires_on: dayFromToday(days),
        }),
        token: TOKEN,
      });
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
      { token: TOKEN },
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

  it('在庫が無ければGeminiを呼ばずに空配列を返す', async () => {
    const householdId = await createHousehold('empty-user', '空の家');
    const { status, body } = await apiJson(
      `/households/${householdId}/recipes/suggestions`,
      { token: 'empty-user' },
    );
    expect(status).toBe(200);
    expect(body.recipes).toEqual([]);
  });

  it('レート制限時は429を返す', async () => {
    const householdId = await createHousehold(TOKEN, 'レート制限テスト');
    await apiJson(`/households/${householdId}/inventory`, {
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
      { token: TOKEN },
    );
    expect(status).toBe(429);
    expect(body.error.code).toBe('gemini_rate_limited');
  });
});
