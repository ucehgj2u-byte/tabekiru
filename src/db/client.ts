import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

/** D1バインディングからDrizzleクライアントを作る。 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export { schema };
