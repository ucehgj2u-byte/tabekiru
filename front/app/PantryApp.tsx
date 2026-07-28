"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Viewer = { displayName: string; email: string; isDemo: boolean } | null;
type Item = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  expiresOn: string;
  purchasedOn: string;
  imageUrl: string | null;
  confidence: number | null;
};
type Recipe = {
  title: string;
  minutes: number;
  matches: string[];
};

const CATEGORIES = [
  { id: "all", label: "すべて", icon: "✦" },
  { id: "vegetable", label: "野菜", icon: "🥬" },
  { id: "fruit", label: "果物", icon: "🍎" },
  { id: "dairy", label: "乳製品", icon: "🥛" },
  { id: "protein", label: "肉・魚・卵", icon: "🥚" },
  { id: "pantry", label: "常温", icon: "🍞" },
  { id: "other", label: "その他", icon: "🫙" },
];

const SAMPLE_ITEMS: Item[] = [
  {
    id: "sample-tomato",
    name: "トマト",
    category: "vegetable",
    quantity: 3,
    unit: "個",
    expiresOn: offsetDate(1),
    purchasedOn: offsetDate(-4),
    imageUrl: null,
    confidence: 0.94,
  },
  {
    id: "sample-milk",
    name: "牛乳",
    category: "dairy",
    quantity: 1,
    unit: "本",
    expiresOn: offsetDate(3),
    purchasedOn: offsetDate(-2),
    imageUrl: null,
    confidence: 0.91,
  },
  {
    id: "sample-apple",
    name: "りんご",
    category: "fruit",
    quantity: 4,
    unit: "個",
    expiresOn: offsetDate(8),
    purchasedOn: offsetDate(-3),
    imageUrl: null,
    confidence: 0.96,
  },
  {
    id: "sample-egg",
    name: "卵",
    category: "protein",
    quantity: 6,
    unit: "個",
    expiresOn: offsetDate(6),
    purchasedOn: offsetDate(-5),
    imageUrl: null,
    confidence: 0.89,
  },
];

function offsetDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysUntil(date: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86400000);
}

function ringProgress(item: Item) {
  const start = new Date(`${item.purchasedOn}T00:00:00`).getTime();
  const end = new Date(`${item.expiresOn}T00:00:00`).getTime();
  const remaining = end - Date.now();
  const total = Math.max(86400000, end - start);
  return Math.max(3, Math.min(100, Math.round((remaining / total) * 100)));
}

function foodEmoji(category: string) {
  return (
    {
      vegetable: "🥬",
      fruit: "🍎",
      dairy: "🥛",
      protein: "🥚",
      pantry: "🍞",
      other: "🫙",
    }[category] ?? "🥣"
  );
}

function expiryLabel(item: Item) {
  const days = daysUntil(item.expiresOn);
  if (days < 0) return `${Math.abs(days)}日超過`;
  if (days === 0) return "今日まで";
  if (days === 1) return "あと1日";
  return `あと${days}日`;
}

export default function PantryApp({ viewer }: { viewer: Viewer }) {
  const [items, setItems] = useState<Item[]>(viewer?.isDemo ? SAMPLE_ITEMS : []);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(viewer));

  useEffect(() => {
    if (!viewer) return;
    fetch("/api/items")
      .then(async (response) => {
        if (!response.ok) throw new Error("在庫を読み込めませんでした");
        return response.json() as Promise<{ items: Item[] }>;
      })
      .then((data) => {
        if (data.items.length || !viewer.isDemo) setItems(data.items);
      })
      .catch((error: Error) => setNotice(error.message))
      .finally(() => setLoading(false));
  }, [viewer]);

  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          (category === "all" || item.category === category) &&
          item.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [category, items, query],
  );

  const urgentItems = items.filter((item) => daysUntil(item.expiresOn) <= 2);

  async function consumeItem(item: Item) {
    if (item.id.startsWith("sample-")) {
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setSelected(null);
      setNotice(`${item.name}を「食べきった」にしました`);
      return;
    }
    const response = await fetch(`/api/items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "consumed" }),
    });
    if (!response.ok) {
      setNotice("更新できませんでした");
      return;
    }
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    setSelected(null);
    setNotice(`${item.name}を「食べきった」にしました`);
  }

  async function showRecipes() {
    setRecipesOpen(true);
    if (!viewer || viewer.isDemo) {
      setRecipes([
        { title: "期限まぢか野菜の具だくさんスープ", minutes: 20, matches: ["トマト"] },
        { title: "冷蔵庫すっきりオムレツ", minutes: 15, matches: ["卵", "牛乳"] },
        { title: "朝のフルーツトースト", minutes: 8, matches: ["りんご"] },
      ]);
      return;
    }
    const response = await fetch("/api/recipes");
    if (response.ok) {
      const data = (await response.json()) as { recipes: Recipe[] };
      setRecipes(data.recipes);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Mogu ホーム">
          <span className="brand-mark">m</span>
          <span>Mogu</span>
        </a>
        <div className="top-actions">
          <button className="icon-button notification-button" aria-label="期限通知">
            ♢
            {urgentItems.length > 0 && <span>{urgentItems.length}</span>}
          </button>
          {viewer ? (
            <div className="account-chip" title={viewer.email}>
              <span>{viewer.displayName.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{viewer.displayName}</strong>
                <small>{viewer.isDemo ? "プレビュー" : "ログイン中"}</small>
              </div>
              {!viewer.isDemo && (
                <a href="/signout-with-chatgpt?return_to=%2F">ログアウト</a>
              )}
            </div>
          ) : (
            <a className="signin-button" href="/signin-with-chatgpt?return_to=%2F">
              ログイン
            </a>
          )}
        </div>
      </header>

      {!viewer && (
        <section className="signin-banner">
          <div>
            <span className="eyebrow">MY PANTRY</span>
            <h1>食材を、おいしく使いきる。</h1>
            <p>写真を撮るだけで在庫と期限をまとめて管理できます。</p>
          </div>
          <a href="/signin-with-chatgpt?return_to=%2F">ChatGPTでサインイン</a>
        </section>
      )}

      <section className="story-section" aria-labelledby="story-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">USE THESE FIRST</span>
            <h1 id="story-title">もうすぐ食べごろ</h1>
          </div>
          <p>リングが小さいほど、期限が近い食材です</p>
        </div>
        <div className="story-row">
          {items.slice(0, 8).map((item) => (
            <button
              className="story"
              key={item.id}
              onClick={() => setSelected(item)}
              aria-label={`${item.name}、${expiryLabel(item)}`}
            >
              <span
                className={`story-ring ${daysUntil(item.expiresOn) <= 1 ? "urgent" : ""}`}
                style={{ "--progress": `${ringProgress(item)}%` } as React.CSSProperties}
              >
                <span className="story-image">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt="" />
                  ) : (
                    <span>{foodEmoji(item.category)}</span>
                  )}
                </span>
              </span>
              <strong>{item.name}</strong>
              <small>{expiryLabel(item)}</small>
            </button>
          ))}
          <button className="story add-story" onClick={() => setAddOpen(true)}>
            <span className="add-story-circle">＋</span>
            <strong>食材を追加</strong>
            <small>写真から</small>
          </button>
        </div>
      </section>

      <div className="story-recipe-action">
        <button onClick={showRecipes}>
          <span>♨</span>
          <div>
            <strong>レシピを見る</strong>
            <small>期限が近い食材から提案します</small>
          </div>
          <b>→</b>
        </button>
      </div>

      {urgentItems.length > 0 && (
        <aside className="waste-alert">
          <span className="alert-icon">!</span>
          <div>
            <strong>{urgentItems.length}品を先に使いましょう</strong>
            <p>
              {urgentItems.map((item) => item.name).join("・")}の期限が近づいています。
            </p>
          </div>
          <button onClick={showRecipes}>レシピを見る →</button>
        </aside>
      )}

      <section className="inventory-section" aria-labelledby="inventory-title">
        <div className="inventory-title-row">
          <div>
            <span className="eyebrow">YOUR INGREDIENTS</span>
            <h2 id="inventory-title">うちの食材</h2>
          </div>
          <label className="search-box">
            <span>⌕</span>
            <input
              type="search"
              placeholder="食材を検索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="category-row" role="list" aria-label="食材カテゴリ">
          {CATEGORIES.map((option) => (
            <button
              key={option.id}
              className={category === option.id ? "active" : ""}
              onClick={() => setCategory(option.id)}
            >
              <span>{option.icon}</span>
              {option.label}
              {option.id === "all" && <small>{items.length}</small>}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="loading-grid" aria-label="在庫を読み込み中">
            {[1, 2, 3, 4].map((key) => <span key={key} />)}
          </div>
        ) : visibleItems.length ? (
          <div className="food-grid">
            {visibleItems.map((item) => {
              const days = daysUntil(item.expiresOn);
              return (
                <article
                  className="food-card"
                  key={item.id}
                  onClick={() => setSelected(item)}
                >
                  <div className={`food-photo food-${item.category}`}>
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={`${item.name}の登録写真`} />
                    ) : (
                      <span>{foodEmoji(item.category)}</span>
                    )}
                    <span className={`expiry-pill ${days <= 1 ? "hot" : ""}`}>
                      {expiryLabel(item)}
                    </span>
                  </div>
                  <div className="food-info">
                    <div>
                      <span className="category-label">
                        {CATEGORIES.find((option) => option.id === item.category)?.label ??
                          "その他"}
                      </span>
                      <h3>{item.name}</h3>
                    </div>
                    <strong>
                      {item.quantity}
                      <small>{item.unit}</small>
                    </strong>
                  </div>
                  <div className="expiry-track">
                    <span style={{ width: `${ringProgress(item)}%` }} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <span>📷</span>
            <h3>このカテゴリにはまだ食材がありません</h3>
            <p>写真を撮って、最初の食材を登録しましょう。</p>
            <button onClick={() => setAddOpen(true)}>食材を登録</button>
          </div>
        )}
      </section>

      <nav className="bottom-dock single-action" aria-label="食材登録">
        <button className="camera-button" onClick={() => setAddOpen(true)}>
          <span>＋</span>
          <small>写真で登録</small>
        </button>
      </nav>

      {selected && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
          <section
            className="story-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selected.name}の詳細`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setSelected(null)} aria-label="閉じる">
              ×
            </button>
            <div className={`modal-photo food-${selected.category}`}>
              {selected.imageUrl ? (
                <img src={selected.imageUrl} alt={`${selected.name}の登録写真`} />
              ) : (
                <span>{foodEmoji(selected.category)}</span>
              )}
            </div>
            <div className="modal-actions">
              <button className="consume-button" onClick={() => consumeItem(selected)}>
                ✓ 食べきった
              </button>
              <button onClick={showRecipes}>この食材でレシピ</button>
            </div>
          </section>
        </div>
      )}

      {addOpen && (
        <AddFoodModal
          viewer={viewer}
          onClose={() => setAddOpen(false)}
          onAdded={(item) => {
            setItems((current) => [item, ...current.filter((old) => !old.id.startsWith("sample-"))]);
            setAddOpen(false);
            setNotice(`${item.name}を在庫に登録しました`);
          }}
        />
      )}

      {recipesOpen && (
        <div className="modal-backdrop" onMouseDown={() => setRecipesOpen(false)}>
          <section className="recipe-modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setRecipesOpen(false)}>×</button>
            <span className="eyebrow">ZERO-WASTE RECIPES</span>
            <h2>いま作るなら、これ。</h2>
            <p className="recipe-lead">期限が近い食材との相性順です。</p>
            <div className="recipe-list">
              {recipes.map((recipe, index) => (
                <article key={recipe.title}>
                  <span>0{index + 1}</span>
                  <div>
                    <h3>{recipe.title}</h3>
                    <p>
                      {recipe.matches.length
                        ? `${recipe.matches.join("・")}が使えます`
                        : "定番食材で作れます"}
                    </p>
                  </div>
                  <strong>{recipe.minutes}分</strong>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {notice && (
        <button className="toast" onClick={() => setNotice(null)}>
          {notice}<span>×</span>
        </button>
      )}
    </main>
  );
}

function AddFoodModal({
  viewer,
  onClose,
  onAdded,
}: {
  viewer: Viewer;
  onClose: () => void;
  onAdded: (item: Item) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("vegetable");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("個");
  const [expiresOn, setExpiresOn] = useState(offsetDate(7));
  const [confidence, setConfidence] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  async function chooseFile(chosen: File) {
    if (!chosen.type.startsWith("image/")) {
      setMessage("画像ファイルを選択してください");
      return;
    }
    setFile(chosen);
    setPreview(URL.createObjectURL(chosen));
    if (!viewer) {
      setMessage("写真の解析と保存にはログインが必要です");
      return;
    }
    setAnalyzing(true);
    setMessage("");
    const body = new FormData();
    body.append("image", chosen);
    try {
      const response = await fetch("/api/analyze", { method: "POST", body });
      const data = (await response.json()) as {
        guess?: {
          name: string;
          category: string;
          quantity: number;
          unit: string;
          suggestedExpiryDays: number;
          confidence: number;
          method: "ai" | "filename";
        };
        error?: string;
      };
      if (!response.ok || !data.guess) throw new Error(data.error || "解析できませんでした");
      setName(data.guess.name);
      setCategory(data.guess.category);
      setQuantity(String(data.guess.quantity));
      setUnit(data.guess.unit);
      setExpiresOn(offsetDate(data.guess.suggestedExpiryDays));
      setConfidence(data.guess.confidence);
      setMessage(
        data.guess.method === "ai"
          ? `AI候補 · 信頼度 ${Math.round(data.guess.confidence * 100)}%`
          : "仮候補です。内容を確認して修正してください",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解析できませんでした");
    } finally {
      setAnalyzing(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!viewer) {
      window.location.href = "/signin-with-chatgpt?return_to=%2F";
      return;
    }
    if (!file || !name.trim()) {
      setMessage("写真と食材名を確認してください");
      return;
    }
    if (viewer.isDemo) {
      onAdded({
        id: `sample-${Date.now()}`,
        name,
        category,
        quantity: Number(quantity),
        unit,
        expiresOn,
        purchasedOn: offsetDate(0),
        imageUrl: preview,
        confidence,
      });
      return;
    }

    setSaving(true);
    const body = new FormData();
    body.append("image", file);
    body.append("name", name);
    body.append("category", category);
    body.append("quantity", quantity);
    body.append("unit", unit);
    body.append("expiresOn", expiresOn);
    body.append("purchasedOn", offsetDate(0));
    body.append("confidence", String(confidence));
    try {
      const response = await fetch("/api/items", { method: "POST", body });
      const data = (await response.json()) as { item?: Item; error?: string };
      if (!response.ok || !data.item) throw new Error(data.error || "登録できませんでした");
      onAdded(data.item);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登録できませんでした");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="add-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="閉じる">×</button>
        <div className="add-heading">
          <span className="eyebrow">ADD INGREDIENT</span>
          <h2>写真から食材を登録</h2>
          <p>AIの候補を確認してから在庫に追加します。</p>
        </div>
        <form onSubmit={submit}>
          <button
            type="button"
            className={`photo-drop ${preview ? "has-photo" : ""}`}
            onClick={() => inputRef.current?.click()}
          >
            {preview ? (
              <img src={preview} alt="登録する写真のプレビュー" />
            ) : (
              <>
                <span className="camera-glyph">◎</span>
                <strong>写真を撮る・選ぶ</strong>
                <small>JPG / PNG · 最大8MB</small>
              </>
            )}
            {analyzing && <span className="analyzing">食材を見つけています…</span>}
          </button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) void chooseFile(chosen);
            }}
          />
          {message && <p className="form-message">{message}</p>}
          <div className="form-grid">
            <label className="span-two">
              食材名
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例：トマト"
                required
              />
            </label>
            <label>
              カテゴリ
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {CATEGORIES.slice(1).map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              期限
              <input
                type="date"
                value={expiresOn}
                onChange={(event) => setExpiresOn(event.target.value)}
                required
              />
            </label>
            <label>
              数量
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                required
              />
            </label>
            <label>
              単位
              <input value={unit} onChange={(event) => setUnit(event.target.value)} required />
            </label>
          </div>
          <button className="primary-submit" disabled={saving || analyzing}>
            {saving ? "登録しています…" : "この内容で在庫に追加"}
          </button>
        </form>
      </section>
    </div>
  );
}
