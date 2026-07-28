import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(async () => {
  // migrations/ のSQLを読み込み、各テストファイルの実行前に適用する
  const migrations = await readD1Migrations(resolve('./migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: resolve('./wrangler.toml') },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // テストではGemini呼び出しを fetchMock で差し替えるためダミーで良い
            GEMINI_API_KEY: 'test-api-key',
            GEMINI_MODEL: 'gemini-3-flash-preview',
            PHOTO_URL_SECRET: 'test-photo-secret',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/applyMigrations.ts'],
      // このプロジェクトのテストは test/ 配下のみ。
      // front/ はデザインの参照元となる別プロジェクトなので対象外にする。
      include: ['test/**/*.test.ts'],
      exclude: ['**/node_modules/**', 'front/**'],
    },
  };
});
