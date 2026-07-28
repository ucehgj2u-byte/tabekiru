import {
  ensureInventorySchema,
  errorResponse,
  getBindings,
  ownerFromRequest,
} from "@/lib/inventory";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const owner = ownerFromRequest(request);
  if (!owner) return new Response("Unauthorized", { status: 401 });

  try {
    const { id } = await context.params;
    const { DB, BUCKET } = getBindings();
    await ensureInventorySchema(DB!);
    const row = await DB!.prepare(
      "SELECT image_key FROM inventory_items WHERE id = ? AND user_email = ?",
    )
      .bind(id, owner)
      .first<{ image_key: string | null }>();
    if (!row?.image_key || !BUCKET) return new Response("Not found", { status: 404 });
    const object = await BUCKET.get(row.image_key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, max-age=3600");
    return new Response(object.body, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
