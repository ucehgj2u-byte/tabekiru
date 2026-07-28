import { asc, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { foodCatalog } from '../db/schema';
import { normalizeName } from '../lib/normalize';
import { foodCatalogQuerySchema, parseQuery } from '../lib/validators';
import type { AppEnv } from '../types';

export const foodCatalogRoute = new Hono<AppEnv>();

/** LIKE のワイルドカードをエスケープする。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** GET /food-catalog?q=xxx — normalized_name の部分一致検索 */
foodCatalogRoute.get('/', async (c) => {
  const db = c.get('db');
  const { q, limit } = parseQuery(c, foodCatalogQuerySchema);

  const base = db.select().from(foodCatalog).$dynamic();

  if (q) {
    const normalized = normalizeName(q);
    const pattern = `%${escapeLike(normalized)}%`;
    const prefix = `${escapeLike(normalized)}%`;

    const rows = await base
      .where(sql`${foodCatalog.normalizedName} LIKE ${pattern} ESCAPE '\\'`)
      // 完全一致 → 前方一致 → その他 の順に並べる
      .orderBy(
        sql`CASE WHEN ${foodCatalog.normalizedName} = ${normalized} THEN 0
                 WHEN ${foodCatalog.normalizedName} LIKE ${prefix} ESCAPE '\\' THEN 1
                 ELSE 2 END`,
        sql`LENGTH(${foodCatalog.normalizedName})`,
        asc(foodCatalog.canonicalName),
      )
      .limit(limit);

    return c.json({ items: rows });
  }

  const rows = await base.orderBy(asc(foodCatalog.canonicalName)).limit(limit);
  return c.json({ items: rows });
});
