import {
  ensureInventorySchema,
  errorResponse,
  getBindings,
  ownerFromRequest,
} from "@/lib/inventory";

const RECIPES = [
  {
    title: "期限まぢか野菜の具だくさんスープ",
    keywords: ["トマト", "にんじん", "玉ねぎ", "キャベツ", "野菜"],
    minutes: 20,
  },
  {
    title: "冷蔵庫すっきりオムレツ",
    keywords: ["卵", "牛乳", "チーズ", "ほうれん草", "玉ねぎ"],
    minutes: 15,
  },
  {
    title: "食べきりチキン炒め",
    keywords: ["鶏肉", "ピーマン", "にんじん", "玉ねぎ"],
    minutes: 18,
  },
  {
    title: "朝のフルーツトースト",
    keywords: ["パン", "バナナ", "りんご", "ヨーグルト"],
    minutes: 8,
  },
];

export async function GET(request: Request) {
  const owner = ownerFromRequest(request);
  if (!owner) return Response.json({ error: "Sign in is required" }, { status: 401 });
  try {
    const { DB } = getBindings();
    await ensureInventorySchema(DB!);
    const rows = await DB!.prepare(
      "SELECT name FROM inventory_items WHERE user_email = ? AND status = 'active'",
    )
      .bind(owner)
      .all<{ name: string }>();
    const names = rows.results.map((row: { name: string }) => row.name);
    const ranked = RECIPES.map((recipe) => ({
      ...recipe,
      matches: recipe.keywords.filter((keyword) =>
        names.some((name: string) => name.includes(keyword) || keyword.includes(name)),
      ),
    }))
      .sort((a, b) => b.matches.length - a.matches.length)
      .slice(0, 3);
    return Response.json({ recipes: ranked });
  } catch (error) {
    return errorResponse(error);
  }
}
