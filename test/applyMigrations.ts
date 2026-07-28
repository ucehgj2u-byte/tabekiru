import { applyD1Migrations, env } from 'cloudflare:test';

// isolatedStorage のシードスタックで実行されるため、
// 各テストからはマイグレーション適用済みのDBが見える。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
