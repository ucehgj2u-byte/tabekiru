import { analyzeFoodImage } from "@/lib/recognition";
import { errorResponse, ownerFromRequest } from "@/lib/inventory";

export async function POST(request: Request) {
  if (!ownerFromRequest(request)) {
    return Response.json({ error: "Sign in is required" }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File) || !file.type.startsWith("image/")) {
      return Response.json({ error: "画像ファイルを選択してください" }, { status: 400 });
    }
    if (file.size > 8 * 1024 * 1024) {
      return Response.json({ error: "画像は8MB以下にしてください" }, { status: 413 });
    }
    return Response.json({ guess: await analyzeFoodImage(file) });
  } catch (error) {
    return errorResponse(error);
  }
}
