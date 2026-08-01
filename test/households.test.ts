import { describe, expect, it } from 'vitest';
import { api, apiJson, createHousehold, jsonBody } from './helpers';

describe('認証', () => {
  it('/health は認証不要', async () => {
    const res = await api('/health', { token: null });
    expect(res.status).toBe(200);
  });

  it('Authorizationヘッダが無いと401', async () => {
    const { status, body } = await apiJson('/households', {
      method: 'POST',
      body: jsonBody({ name: 'x' }),
      token: null,
    });
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('初回ログインでユーザーが自動作成される', async () => {
    const { status, body } = await apiJson('/me', { token: 'user-me' });
    expect(status).toBe(200);
    expect(body.user.email).toBe('user-me@example.local');
  });

  it('不正なBearerトークンは401', async () => {
    const res = await api('/households', { token: null, headers: { Authorization: 'Bearer not-a-real-jwt' } });
    expect(res.status).toBe(401);
  });
});

describe('households', () => {
  it('作成者がownerとしてmembersに自動追加される', async () => {
    const { status, body } = await apiJson('/households', {
      method: 'POST',
      body: jsonBody({ name: '山田家' }),
      token: 'owner-1',
    });
    expect(status).toBe(201);
    expect(body.household.name).toBe('山田家');

    const detail = await apiJson(`/households/${body.household.id}`, {
      token: 'owner-1',
    });
    expect(detail.status).toBe(200);
    expect(detail.body.members).toHaveLength(1);
    expect(detail.body.members[0].role).toBe('owner');
    expect(detail.body.members[0].status).toBe('active');
  });

  it('GET /households は自分が所属する家庭だけを返す', async () => {
    await createHousehold('list-user', '家A');
    await createHousehold('list-user', '家B');
    await createHousehold('other-list-user', '他人の家');

    const { status, body } = await apiJson('/households', { token: 'list-user' });
    expect(status).toBe(200);
    expect(body.households.map((h: any) => h.name)).toEqual(['家A', '家B']);
    expect(body.households[0].role).toBe('owner');
  });

  it('nameが空だと400', async () => {
    const { status, body } = await apiJson('/households', {
      method: 'POST',
      body: jsonBody({ name: '' }),
      token: 'owner-2',
    });
    expect(status).toBe(400);
    expect(body.error.details).toBeDefined();
  });

  it('メンバーでないユーザーは403', async () => {
    const householdId = await createHousehold('owner-3');
    const { status, body } = await apiJson(`/households/${householdId}`, {
      token: 'stranger',
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('存在しないhouseholdは404', async () => {
    const { status } = await apiJson('/households/hh_does_not_exist', {
      token: 'owner-4',
    });
    expect(status).toBe(404);
  });

  it('メンバー追加ができ、activeなら閲覧できる', async () => {
    const householdId = await createHousehold('owner-5');

    const added = await apiJson(`/households/${householdId}/members`, {
      method: 'POST',
      body: jsonBody({ email: 'partner@example.com', status: 'active' }),
      token: 'owner-5',
    });
    expect(added.status).toBe(201);
    expect(added.body.member.status).toBe('active');

    // 招待されたユーザーが同じメールでログインすると閲覧できる
    const viewed = await apiJson(`/households/${householdId}`, {
      token: 'partner@example.com',
    });
    expect(viewed.status).toBe(200);
    expect(viewed.body.members).toHaveLength(2);
  });

  it('invited状態のメンバーはまだアクセスできない', async () => {
    const householdId = await createHousehold('owner-6');
    await apiJson(`/households/${householdId}/members`, {
      method: 'POST',
      body: jsonBody({ email: 'pending@example.com' }),
      token: 'owner-6',
    });

    const { status, body } = await apiJson(`/households/${householdId}`, {
      token: 'pending@example.com',
    });
    expect(status).toBe(403);
    expect(body.error.message).toContain('招待中');
  });

  it('ownerでないメンバーはメンバー追加できない', async () => {
    const householdId = await createHousehold('owner-7');
    await apiJson(`/households/${householdId}/members`, {
      method: 'POST',
      body: jsonBody({ email: 'member@example.com', status: 'active' }),
      token: 'owner-7',
    });

    const { status } = await apiJson(`/households/${householdId}/members`, {
      method: 'POST',
      body: jsonBody({ email: 'another@example.com' }),
      token: 'invite:member@example.com',
    });
    expect(status).toBe(403);
  });
});

describe('storage_locations', () => {
  it('作成・一覧取得ができる', async () => {
    const householdId = await createHousehold('loc-user');

    const created = await apiJson(`/households/${householdId}/storage-locations`, {
      method: 'POST',
      body: jsonBody({ name: '冷蔵室', type: 'fridge', sort_order: 1 }),
      token: 'loc-user',
    });
    expect(created.status).toBe(201);
    expect(created.body.storage_location.type).toBe('fridge');

    await apiJson(`/households/${householdId}/storage-locations`, {
      method: 'POST',
      body: jsonBody({ name: '冷凍室', type: 'freezer', sort_order: 0 }),
      token: 'loc-user',
    });

    const list = await apiJson(`/households/${householdId}/storage-locations`, {
      token: 'loc-user',
    });
    expect(list.status).toBe(200);
    expect(list.body.storage_locations.map((l: any) => l.name)).toEqual([
      '冷凍室',
      '冷蔵室',
    ]);
  });

  it('不正なtypeは400', async () => {
    const householdId = await createHousehold('loc-user-2');
    const { status } = await apiJson(`/households/${householdId}/storage-locations`, {
      method: 'POST',
      body: jsonBody({ name: '棚', type: 'shelf' }),
      token: 'loc-user-2',
    });
    expect(status).toBe(400);
  });
});

describe('food_catalog', () => {
  it('部分一致で検索できる', async () => {
    const { status, body } = await apiJson('/food-catalog?q=にんじん', {
      token: 'catalog-user',
    });
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].canonical_name).toBe('にんじん');
  });

  it('全角・大文字などの表記ゆれを正規化して検索できる', async () => {
    const { body } = await apiJson('/food-catalog?q=ト マト', {
      token: 'catalog-user',
    });
    expect(body.items.map((i: any) => i.canonical_name)).toContain('トマト');
  });

  it('qなしなら一覧を返す', async () => {
    const { status, body } = await apiJson('/food-catalog?limit=5', {
      token: 'catalog-user',
    });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(5);
  });
});
