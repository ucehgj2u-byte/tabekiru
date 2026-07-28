import { env } from "cloudflare:workers";

export type InventoryItem = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  expiresOn: string;
  purchasedOn: string;
  imageUrl: string | null;
  status: string;
  confidence: number | null;
  createdAt: string;
};

type InventoryRow = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  expires_on: string;
  purchased_on: string;
  image_key: string | null;
  status: string;
  confidence: number | null;
  created_at: string;
};

export function getBindings() {
  const bindings = env as unknown as {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    OPENAI_API_KEY?: string;
    OPENAI_VISION_MODEL?: string;
  };
  if (!bindings.DB) throw new Error("D1 binding DB is unavailable");
  return bindings;
}

export function ownerFromRequest(request: Request): string | null {
  const authenticated = request.headers.get("oai-authenticated-user-email");
  if (authenticated) return authenticated;

  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return "demo@localhost";
  }
  return null;
}

export async function ensureInventorySchema(db: D1Database) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        unit TEXT NOT NULL DEFAULT '個',
        expires_on TEXT NOT NULL,
        purchased_on TEXT NOT NULL,
        image_key TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS inventory_owner_expiry_idx
      ON inventory_items (user_email, status, expires_on)
    `),
  ]);
}

export function rowToItem(row: InventoryRow): InventoryItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    unit: row.unit,
    expiresOn: row.expires_on,
    purchasedOn: row.purchased_on,
    imageUrl: row.image_key ? `/api/images/${row.id}` : null,
    status: row.status,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status: 500 });
}
