import {
  ensureInventorySchema,
  errorResponse,
  getBindings,
  ownerFromRequest,
  rowToItem,
} from "@/lib/inventory";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const owner = ownerFromRequest(request);
  if (!owner) return Response.json({ error: "Sign in is required" }, { status: 401 });

  try {
    const { id } = await context.params;
    const payload = (await request.json()) as {
      quantity?: number;
      expiresOn?: string;
      status?: "active" | "consumed" | "discarded";
    };
    const { DB } = getBindings();
    await ensureInventorySchema(DB!);
    const current = await DB!.prepare(
      "SELECT * FROM inventory_items WHERE id = ? AND user_email = ?",
    )
      .bind(id, owner)
      .first();
    if (!current) return Response.json({ error: "Not found" }, { status: 404 });

    const row = current as Record<string, unknown>;
    const quantity =
      payload.quantity !== undefined ? Math.max(0, Number(payload.quantity)) : Number(row.quantity);
    const status = payload.status ?? (quantity === 0 ? "consumed" : String(row.status));
    const expiresOn = payload.expiresOn ?? String(row.expires_on);
    await DB!.prepare(
      "UPDATE inventory_items SET quantity = ?, expires_on = ?, status = ? WHERE id = ? AND user_email = ?",
    )
      .bind(quantity, expiresOn, status, id, owner)
      .run();
    const updated = await DB!.prepare("SELECT * FROM inventory_items WHERE id = ?")
      .bind(id)
      .first();
    return Response.json({ item: rowToItem(updated as never) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const owner = ownerFromRequest(request);
  if (!owner) return Response.json({ error: "Sign in is required" }, { status: 401 });

  try {
    const { id } = await context.params;
    const { DB, BUCKET } = getBindings();
    await ensureInventorySchema(DB!);
    const row = await DB!.prepare(
      "SELECT image_key FROM inventory_items WHERE id = ? AND user_email = ?",
    )
      .bind(id, owner)
      .first<{ image_key: string | null }>();
    if (!row) return Response.json({ error: "Not found" }, { status: 404 });
    if (row.image_key && BUCKET) await BUCKET.delete(row.image_key);
    await DB!.prepare("DELETE FROM inventory_items WHERE id = ? AND user_email = ?")
      .bind(id, owner)
      .run();
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
