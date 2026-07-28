import {
  ensureInventorySchema,
  errorResponse,
  getBindings,
  ownerFromRequest,
  rowToItem,
} from "@/lib/inventory";

export async function GET(request: Request) {
  const owner = ownerFromRequest(request);
  if (!owner) return Response.json({ error: "Sign in is required" }, { status: 401 });
  try {
    const { DB } = getBindings();
    await ensureInventorySchema(DB!);
    const rows = await DB!.prepare(
      `SELECT * FROM inventory_items
       WHERE user_email = ? AND status = 'active'
       AND expires_on <= date('now', '+2 day')
       ORDER BY expires_on ASC`,
    )
      .bind(owner)
      .all();
    return Response.json({
      notifications: rows.results.map((row: Record<string, unknown>) => ({
        type: "expiry",
        item: rowToItem(row as never),
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
