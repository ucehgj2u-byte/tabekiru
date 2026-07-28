import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("defines the Mogu pantry experience and removes starter metadata", async () => {
  const [app, page, layout] = await Promise.all([
    readFile(new URL("app/PantryApp.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  assert.match(layout, /Mogu — 食材を、おいしく使いきる/);
  assert.match(app, /もうすぐ食べごろ/);
  assert.match(app, /うちの食材/);
  assert.match(app, /写真で登録/);
  assert.match(app, /aria-label="食材登録"/);
  assert.match(app, /aria-label="食材カテゴリ"/);
  assert.match(app, /story-recipe-action/);
  assert.doesNotMatch(app, /className="modal-copy"/);
  assert.match(page, /getChatGPTUser/);
  assert.doesNotMatch(`${app}${page}${layout}`, /Your site is taking shape|codex-preview/);
});

test("ships owned inventory, upload, notification and recipe APIs", async () => {
  const [items, images, notifications, recipes, migration, hosting] =
    await Promise.all([
      readFile(new URL("app/api/items/route.ts", root), "utf8"),
      readFile(new URL("app/api/images/[id]/route.ts", root), "utf8"),
      readFile(new URL("app/api/notifications/route.ts", root), "utf8"),
      readFile(new URL("app/api/recipes/route.ts", root), "utf8"),
      readFile(new URL("drizzle/0000_chubby_jocasta.sql", root), "utf8"),
      readFile(new URL(".openai/hosting.json", root), "utf8"),
    ]);

  assert.match(items, /ownerFromRequest/);
  assert.match(items, /BUCKET\.put/);
  assert.match(images, /user_email = \?/);
  assert.match(notifications, /date\('now', '\+2 day'\)/);
  assert.match(recipes, /RECIPES/);
  assert.match(migration, /CREATE TABLE `inventory_items`/);
  const hostingConfig = JSON.parse(hosting);
  assert.equal(hostingConfig.d1, "DB");
  assert.equal(hostingConfig.r2, "BUCKET");
  assert.match(hostingConfig.project_id, /^appgprj_/);
});
