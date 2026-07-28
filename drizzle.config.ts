import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit の設定。
 * スキーマ変更後は `npm run db:generate` で migrations/ にSQLを生成し、
 * `npm run db:migrate:local` / `db:migrate:remote` で D1 に適用します。
 */
export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
} satisfies Config;
