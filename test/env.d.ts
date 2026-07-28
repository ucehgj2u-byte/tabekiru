import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Bindings } from '../src/types';

/**
 * `cloudflare:test` の env の型。
 * wrangler.toml のバインディング + テスト専用バインディングを宣言する。
 */
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
