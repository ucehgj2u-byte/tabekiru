import {
  ensureInventorySchema,
  errorResponse,
  getBindings,
  ownerFromRequest,
  rowToItem,
} from "@/lib/inventory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = ownerFromRequest(request);
  if (!owner) return Response.json({ error: "Sign in is required" }, { status: 401 });

  try {
    const { DB } = getBindings();
    await ensureInventorySchema(DB!);
    const rows = await DB!.prepare(
      `SELECT * FROM inventory_items
       WHERE user_email = ? AND status = 'active'
       ORDER BY expires_on ASC, created_at DESC`,
    )
      .bind(owner)
      .all();
    return Response.json({
      items: rows.results.map((row: Record<string, unknown>) => rowToItem(row as never)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const owner = ownerFromRequest(request);
  if (!owner) return Response.json({ error: "Sign in is required" }, { status: 401 });

  try {
    const form = await request.formData();
    const image = form.get("image");
    const name = String(form.get("name") ?? "").trim();
    const category = String(form.get("category") ?? "other");
    const quantity = Number(form.get("quantity") ?? 1);
    const unit = String(form.get("unit") ?? "個").trim();
    const expiresOn = String(form.get("expiresOn") ?? "");
    const purchasedOn = String(form.get("purchasedOn") ?? "");
    const confidence = Number(form.get("confidence") ?? 0);

    if (!name || !expiresOn || !purchasedOn || !Number.isFinite(quantity) || quantity <= 0) {
      return Response.json({ error: "入力内容を確認してください" }, { status: 400 });
    }

    const { DB, BUCKET } = getBindings();
    await ensureInventorySchema(DB!);
    const id = crypto.randomUUID();
    let imageKey: string | null = null;
    if (image instanceof File && image.size > 0) {
      if (!image.type.startsWith("image/") || image.size > 8 * 1024 * 1024) {
        return Response.json({ error: "8MB以下の画像を選択してください" }, { status: 400 });
      }
      if (!BUCKET) throw new Error("R2 binding BUCKET is unavailable");
      imageKey = `${owner}/${id}`;
      await BUCKET.put(imageKey, image.stream(), {
        httpMetadata: { contentType: image.type || "image/jpeg" },
      });
    }

    await DB!.prepare(
      `INSERT INTO inventory_items
       (id, user_email, name, category, quantity, unit, expires_on, purchased_on, image_key, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        owner,
        name,
        category,
        quantity,
        unit || "個",
        expiresOn,
        purchasedOn,
        imageKey,
        Number.isFinite(confidence) ? confidence : null,
      )
      .run();

    const row = await DB!.prepare("SELECT * FROM inventory_items WHERE id = ?")
      .bind(id)
      .first();
    return Response.json({ item: rowToItem(row as never) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
