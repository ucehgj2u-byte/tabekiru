import { getBindings } from "./inventory";

export type FoodGuess = {
  name: string;
  category: string;
  quantity: number;
  unit: string;
  suggestedExpiryDays: number;
  confidence: number;
  method: "ai" | "filename";
};

const FOOD_HINTS = [
  { keys: ["tomato", "トマト"], name: "トマト", category: "vegetable", days: 6 },
  { keys: ["carrot", "にんじん"], name: "にんじん", category: "vegetable", days: 12 },
  { keys: ["onion", "たまねぎ", "玉ねぎ"], name: "玉ねぎ", category: "vegetable", days: 25 },
  { keys: ["apple", "りんご"], name: "りんご", category: "fruit", days: 14 },
  { keys: ["banana", "バナナ"], name: "バナナ", category: "fruit", days: 5 },
  { keys: ["milk", "牛乳"], name: "牛乳", category: "dairy", days: 5, unit: "本" },
  { keys: ["egg", "たまご", "卵"], name: "卵", category: "protein", days: 14, unit: "個" },
  { keys: ["chicken", "鶏"], name: "鶏肉", category: "protein", days: 2, unit: "パック" },
  { keys: ["bread", "パン"], name: "パン", category: "pantry", days: 4, unit: "袋" },
] as const;

function filenameGuess(filename: string): FoodGuess {
  const normalized = filename.toLowerCase();
  const hit = FOOD_HINTS.find((food) =>
    food.keys.some((key) => normalized.includes(key.toLowerCase())),
  );
  return {
    name: hit?.name ?? "撮影した食材",
    category: hit?.category ?? "other",
    quantity: 1,
    unit: hit && "unit" in hit ? hit.unit : "個",
    suggestedExpiryDays: hit?.days ?? 7,
    confidence: hit ? 0.55 : 0.2,
    method: "filename",
  };
}

function extractText(payload: Record<string, unknown>): string | null {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const message of output) {
    if (!message || typeof message !== "object") continue;
    const content = Array.isArray((message as { content?: unknown }).content)
      ? (message as { content: Array<Record<string, unknown>> }).content
      : [];
    for (const part of content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return null;
}

export async function analyzeFoodImage(file: File): Promise<FoodGuess> {
  const bindings = getBindings();
  if (!bindings.OPENAI_API_KEY) return filenameGuess(file.name);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const dataUrl = `data:${file.type || "image/jpeg"};base64,${btoa(binary)}`;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bindings.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: bindings.OPENAI_VISION_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Identify the main food ingredient and estimated visible quantity.",
                "Return JSON only with: name (Japanese), category (vegetable|fruit|dairy|protein|pantry|other),",
                "quantity (number), unit (Japanese), suggestedExpiryDays (integer), confidence (0-1).",
              ].join(" "),
            },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    }),
  });

  if (!response.ok) return filenameGuess(file.name);
  const payload = (await response.json()) as Record<string, unknown>;
  const text = extractText(payload);
  if (!text) return filenameGuess(file.name);

  try {
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")) as Partial<FoodGuess>;
    return {
      name: String(parsed.name || "撮影した食材"),
      category: String(parsed.category || "other"),
      quantity: Number(parsed.quantity) || 1,
      unit: String(parsed.unit || "個"),
      suggestedExpiryDays: Math.max(1, Number(parsed.suggestedExpiryDays) || 7),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
      method: "ai",
    };
  } catch {
    return filenameGuess(file.name);
  }
}
