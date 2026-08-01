# 食品ロス削減アプリ — バックエンドAPI

写真から食材を認識して家庭の在庫を管理し、期限が近いものを優先して使うレシピを提案する
Web APIです。UIは別リポジトリ/別実装を想定しており、ここではバックエンドのみを扱います。

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| ランタイム | Cloudflare Workers |
| フレームワーク | Hono (TypeScript) |
| DB | Cloudflare D1 (SQLite互換) |
| ストレージ | Cloudflare R2（画像本体） |
| ORM | Drizzle ORM (D1) |
| バリデーション | Zod |
| 画像認識・レシピ提案 | Google Gemini API (`gemini-3-flash-preview`, REST/fetch) |
| テスト | Vitest + @cloudflare/vitest-pool-workers (Miniflare) |

---

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. D1 データベースの作成

```bash
npx wrangler d1 create food-loss-db
```

出力された `database_id` を `wrangler.toml` の
`REPLACE_WITH_YOUR_D1_DATABASE_ID` と差し替えてください。

> ローカル開発（`wrangler dev` / テスト）だけなら `database_id` は
> プレースホルダのままでも動作します。

### 3. R2 バケットの作成

```bash
npx wrangler r2 bucket create food-loss-photos
```

```bash
npx wrangler r2 bucket create food-loss-photos-preview
```

### 4. Gemini APIキーの設定

APIキーはリポジトリに含めません。**ローカル**は `.dev.vars`、**本番**は `wrangler secret` で管理します。

ローカル:

```bash
cp .dev.vars.example .dev.vars
```

作成した `.dev.vars` に自分のキーを記入します（`.dev.vars` は `.gitignore` 済み）。

本番（Workers のシークレットとして登録）:

```bash
npx wrangler secret put GEMINI_API_KEY
```

画像取得URLの署名鍵も本番では上書きしてください:

```bash
npx wrangler secret put PHOTO_URL_SECRET
```

### 5. マイグレーションの適用

ローカル:

```bash
npm run db:migrate:local
```

本番:

```bash
npm run db:migrate:remote
```

`migrations/0002_seed_food_catalog.sql` で食材カタログの初期データ（36件）も投入されます。

### 6. 開発サーバーの起動

```bash
npm run dev
```

ブラウザで **http://localhost:8787** を開くと、動作確認用のGUIが表示されます。

---

## GUI（Mogu）

`http://localhost:8787/` で、APIと同じWorkerから配信される1ページのGUIが開きます
（[src/ui/app.html](src/ui/app.html)。ビルド不要・依存ライブラリなし）。

デザインは `front/`（Next.js製のデザイン参照実装）の
`app/globals.css` と `app/PantryApp.tsx` を移植したものです。
見た目・レイアウト・画面遷移はそちらに合わせつつ、
データのやり取りはすべて本リポジトリのAPIを使っています。

できること:

- **もうすぐ食べごろ** — 期限が近い順のストーリー表示（リングの残量＝期限までの残り）
- **期限が近い食材の警告バー**とヘッダーの通知バッジ
- **うちの食材** — カード一覧、食材名の検索、カテゴリ（野菜・肉・魚介など）での絞り込み
- 食材をタップして詳細 → **食べきった / 捨てる / 量を指定して消費 / この食材でレシピ**
- **カメラで撮影、または写真を選んで食材を自動認識** → 候補ごとに名前・数量・種類・期限を
  修正して在庫に登録（1枚の写真から複数の食材を登録できます）
  - パッケージの**賞味期限を読み取って自動入力**（読めない場合は一般的な日持ちから推定）
- 写真を使わない**手入力**での追加
- 期限が近い食材を使う**レシピ提案**（手順つき）
- **使いきれた記録** — 使いきった量・捨てた量・使いきれた割合と操作履歴
- 家庭の作成と切り替え、ユーザーの切り替え

利用者の識別子は初回訪問時に自動生成してブラウザに保存するため、通常は意識する必要がありません。
家族で分けたい場合は右上の 👤 ボタンから切り替えられます
（この文字列がそのまま `Authorization: Bearer <token>` として送られます）。

フロントエンドを別途実装する場合も、このファイルがAPIの呼び出し例として使えます。

### 2種類のカメラ

用途が違うため、カメラを2つに分けています。

| | 用途 | 写真の扱い |
| --- | --- | --- |
| 📷 食材を撮る | 食材の判定（名前・種類・数量） | **R2に保存し、在庫カードの画像になる** |
| 📅 賞味期限を撮る | パッケージの日付の読み取りのみ | 読み取り後に破棄（保存しない） |

賞味期限カメラは、候補カードと手入力フォームの日付欄の横にある 📅 ボタンから開きます。
食材ごとに日付が違うため、「どの食材の期限か」が明確になる位置に置いています。
読み取れた場合は日付欄に自動入力され、読めなかった場合は認識できた文字を添えて手入力を促します。

カメラは登録画面の上に重ねて開くため、撮影中も入力内容は保持されます。

### カメラの動作環境

「📷 カメラで撮る」は環境に応じて2通りの動き方をします。

| 環境 | 動作 |
| --- | --- |
| PC / HTTPS のスマホ | ページ内にプレビューを出し、その場で撮影（`getUserMedia`） |
| HTTP のスマホ、権限拒否時 | OSのカメラアプリを起動（`<input capture>`）。撮影後そのまま認識へ |

`getUserMedia` は **HTTPS か localhost でしか動きません**。
スマホの実機で試す場合は次のどちらかになります。

**A. 同じWi-FiのLAN経由（HTTPのまま・手軽）**

```bash
npm run dev:lan
```

Macのローカルアドレス（`ipconfig getifaddr en0` で確認）を使って
スマホから `http://<Macのアドレス>:8787` を開きます。この場合は
OSのカメラアプリを起動するフォールバック経路で撮影できます。

**B. Cloudflareに公開（HTTPSでページ内プレビューも使える）**

```bash
npm run deploy
```

払い出される `https://～.workers.dev` を開きます。

---

## コマンド一覧

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | ローカル開発サーバー（wrangler dev） |
| `npm run dev:lan` | 同じWi-Fiのスマホからも開ける状態で起動 |
| `npm test` | 統合テスト（Vitest + Miniflare） |
| `npm run typecheck` | 型チェック |
| `npm run db:generate` | スキーマ変更からマイグレーションSQLを生成（drizzle-kit） |
| `npm run db:migrate:local` | ローカルD1にマイグレーション適用 |
| `npm run db:migrate:remote` | 本番D1にマイグレーション適用 |
| `npm run deploy` | Workersへデプロイ |

---

## 認証（MVPの簡易版）

すべての業務APIは `Authorization: Bearer <token>` を要求します。
MVPではトークンをそのまま `users.auth_user_id` として扱い、**未登録なら自動でユーザーを作成**します。
本番ではこのミドルウェア（[src/middleware/auth.ts](src/middleware/auth.ts)）をOAuth/JWT検証に差し替えてください。

```bash
curl http://127.0.0.1:8787/me -H "Authorization: Bearer demo-user"
```

初回作成時のみ、任意ヘッダでプロフィールを指定できます。

- `X-User-Email`（省略時 `<token>@example.local`）
- `X-User-Display-Name`（省略時 `<token>`）

household配下のリソースには、**そのhouseholdの `active` メンバーだけ**がアクセスできます
（`invited` のままではアクセスできません）。

---

## API一覧

レスポンスのキーはすべて snake_case です。エラーは以下の形式で返ります。

```json
{ "error": { "code": "bad_request", "message": "入力値が不正です", "details": [] } }
```

| ステータス | 用途 |
| --- | --- |
| 400 | バリデーションエラー（Zod） |
| 401 | 認証ヘッダなし／不正 |
| 403 | householdのメンバーでない |
| 404 | リソースが存在しない |
| 409 | 状態の競合（消費済み在庫の再操作など） |
| 422 | 形式は正しいが業務ルール違反（残量超過など） |
| 429 | Gemini APIのレート制限 |
| 502 | Gemini API呼び出し失敗 |

### households

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/households` | 自分が所属する家庭の一覧 |
| POST | `/households` | 作成（作成者をownerとしてメンバー登録） |
| GET | `/households/:id` | 詳細＋メンバー一覧 |
| POST | `/households/:id/members` | メンバー招待/追加（ownerのみ） |

メンバー追加は `user_id` または `email` を指定します。`status` は既定で `invited`、
すぐアクセスさせたい場合は `"status": "active"` を指定します。

### storage_locations

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/households/:id/storage-locations` | 一覧（sort_order順） |
| POST | `/households/:id/storage-locations` | 作成（type: `fridge` / `freezer` / `pantry`） |

### food_catalog

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/food-catalog?q=にん&limit=20` | `normalized_name` の部分一致検索 |

検索語はNFKC正規化・小文字化・空白除去してから照合します（完全一致→前方一致→部分一致の順）。

### photos / 画像認識

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/households/:id/photos` | multipart（`file`）で画像アップロード → R2保存 |
| POST | `/households/:id/expiry-scan` | 賞味期限の印字だけを読み取る（**画像は保存しない**） |
| GET | `/households/:id/photos` | 写真一覧 |
| GET | `/photos/:id` | メタ情報＋署名付きURL再発行 |
| GET | `/photos/:id/content` | 画像本体（署名付きURL または Bearer） |
| POST | `/photos/:id/recognize` | 認識ジョブを作成し非同期実行（202） |
| GET | `/photos/:id/recognition-jobs` | この写真のジョブ一覧 |
| GET | `/recognition-jobs/:id` | ジョブのステータス |
| GET | `/recognition-jobs/:id/candidates` | 検出候補一覧（確信度の降順） |
| PATCH | `/recognition-candidates/:id` | 候補の修正（名前・数量・単位・却下） |
| POST | `/recognition-candidates/:id/confirm` | 候補を確定して在庫に登録 |

対応画像形式は jpeg / png / webp / heic / heif、上限10MBです。

> **署名付きURLについて**: Workers の R2 バインディングには presign API がないため、
> 本APIでは HMAC-SHA256 + 有効期限（既定15分）付きの
> `/photos/:id/content?expires=...&signature=...` を発行してこれに代えています。
> 認証ヘッダを付けられない `<img src>` からも参照できます。

### inventory

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/households/:id/inventory` | 在庫一覧（**期限が近い順**） |
| POST | `/households/:id/inventory` | 手動登録（`created` イベントも記録） |
| GET | `/inventory/:id` | 単体取得 |
| PATCH | `/inventory/:id` | 数量・保存場所などの修正（`adjusted` を記録） |
| POST | `/inventory/:id/consume` | 消費（`consumed` を記録、0で `status=consumed`） |
| POST | `/inventory/:id/discard` | 廃棄（`discarded` を記録、食品ロス集計の元データ） |
| POST | `/inventory/:id/open` | 開封済みにする（`opened` を記録、期限をカテゴリ別ルールで再計算） |
| GET | `/inventory/:id/events` | このロットの履歴 |

一覧のクエリ: `status`(`active`/`consumed`/`discarded`/`all`)、`category`、`location_id`、
`expiring_within_days`、`limit`、`offset`。
各アイテムには `days_until_expiry` と `is_expired` が付きます。

### 開封後の期限

`POST /inventory/:id/open` は AI を呼ばず、[src/lib/openedShelfLife.ts](src/lib/openedShelfLife.ts)
のカテゴリ別固定ルール（例: 肉=1日、乳製品=3日、調味料=30日）で新しい消費期限を即座に計算します。
「開封日 + カテゴリ日数」と「元々の消費期限」を比較し、**早い方**を採用するため、開封したことで
期限が延びることはありません。二重開封や、`active` 以外の在庫への操作は 409 で拒否します。

`category` は次の固定値から選びます（表記ゆれで集計が壊れないよう限定しています）。

`野菜` / `果物` / `肉` / `魚介` / `乳製品` / `卵` / `大豆製品` / `主食` / `惣菜` / `調味料` / `飲料` / `その他`

`consume` / `discard` の `quantity` を省略すると**残量すべて**が対象になります。

### events

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/households/:id/events?from=&to=` | 履歴一覧＋種別ごとの集計 |
| GET | `/households/:id/events/daily` | 日別集計（グラフ用） |

`summary` に種別ごとの件数・数量合計、`loss_stats` に消費量・廃棄量・消費率が入ります。

### recipes

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/households/:id/recipes/suggestions` | 選んだ食材でレシピ提案（`inventory_lot_ids`必須） |
| GET | `/households/:id/recipes/history` | これまでの提案履歴（新しい順） |
| POST | `/households/:id/recipes/consume` | 「これを作った」時に使った食材をまとめて消費 |

`inventory_lot_ids` は1〜30件。**「期限が近い順に自動で選んでレシピ提案する」機能は廃止しています**
（呼び出すたびにGemini APIのコストが発生するため、ユーザーが明示的に選んだ時だけ呼び出す設計にしています）。

提案が成功すると `recipe_suggestions` テーブルに履歴として自動保存され、`GET /recipes/history` で
`limit`・`offset` 付きで一覧取得できます。各エントリには使った食材(`based_on`)とレシピ本文
（`missing_ingredients` を含む）がスナップショットとして残ります。

各レシピには `ingredient_amounts`（`{ name, quantity, unit }[]`）として、AIが出した使用量の目安が
付きます。「これを作った」ボタンでこの目安を確認ダイアログに出し、ユーザーが数量を調整してから
`POST /recipes/consume` に `{ recipe_title?, items: [{ inventory_lot_id, quantity }] }` を送ると、
指定した在庫をまとめて消費（`inventory_events` に `consumed` を記録）します。
残量を超える数量を送っても400にはせず残量まで丸め、一部の食材が消費済み等で失敗しても他の食材の
消費は続行し、`consumed` / `failed` の内訳を返します。

---

## Gemini API の使い方

呼び出しは [src/lib/geminiClient.ts](src/lib/geminiClient.ts) に集約し、
[recognitionService](src/services/recognitionService.ts) と
[recipeService](src/services/recipeService.ts) は薄いラッパーになっています。

- エンドポイント: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
- モデルは環境変数 `GEMINI_MODEL` で切り替え可能（既定 `gemini-3-flash-preview`）。
  無料枠のレート制限に当たる場合は `wrangler.toml` の `GEMINI_MODEL` を
  `gemini-3.1-flash-lite` に変更してください。

> **モデル名についての注意**
> `gemini-3-flash` という名前は Gemini API の v1beta では提供されておらず、
> 呼び出すと `404 NOT_FOUND` になります（`models/gemini-3-flash is not found for API version v1beta`）。
> 実際に呼べる名前は **`gemini-3-flash-preview`** のため、これを既定にしています。
> `gemini-3.1-flash-lite` も同じキーで利用可能なことを確認済みです。
> 利用可能なモデルは以下で確認できます。
>
> ```bash
> curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" | grep '"name"'
> ```
- `responseMimeType: application/json` + `responseSchema` でJSON構造を固定しています。
- **JSONとして読めない場合はリトライせずエラー**にします（MVPスコープ）。
- **429** を受け取った場合は、その旨をエラーメッセージに含めてジョブを失敗扱いにします。
  再試行すると状況が悪化するため、429はリトライしません。
- **503（モデル混雑）など一時的な障害のみ、1回だけ再試行**します。
  実際に発生した事例に対応したもので、1.2秒後に1度だけ試し、それでも駄目ならエラーにします。

### 画像認識の流れ

1. `POST /photos/:id/recognize` で `recognition_jobs` を `pending` で作成
2. `waitUntil()` でバックグラウンド実行（ステータスは `processing` へ）
3. `photos.r2_key` でR2から画像を取得 → Base64化 → Gemini へ送信
4. 結果を `recognition_candidates` に1件ずつ登録し、ジョブを `completed`、
   `model_name` に実際に使ったモデル名を保存
5. 失敗時は `status = 'failed'`、`error_message` に理由を保存

1回の呼び出しで、食材名・数量・単位・確信度に加えて次も取得します。

- **カテゴリ**（野菜・肉・魚介など。上記の固定リストから選ばせ、外れた値は「その他」に寄せます）
- **消費期限** — パッケージに印字があれば読み取り（`expiry_source = 'printed'`）、
  読み取れない野菜などは一般的な日持ち日数から算出します（`expiry_source = 'estimated'`）。
  結果は `recognition_candidates.suggested_expires_on` に入り、
  `confirm` で `expires_on` を省略するとこの値が使われます。

補足:

- `bounding_box_json` はMVPでは常に `null`（Gemini Visionの座標精度が保証されないため）
- 確信度が低い候補（0.5未満）もそのまま登録します。UI側で「低確信度」として区別してください。
- 期限は推定値を含むため、UIでは根拠（印字 / 目安）を明示してユーザーが直せるようにしています。

---

## データモデルの方針

- **household（家庭）** を中心単位とし、複数ユーザーが1つのhouseholdに所属します。
- 食材は **購入ロット単位** で管理します（同じ食材でも購入日・期限が違えば別レコード）。
- 在庫の増減履歴 `inventory_events` は **追記のみ**。
  更新・削除するAPIは実装していません（集計の整合性を守るため）。
- 画像本体はR2に保存し、DBには `r2_key` のみを持たせます。
- `expires_on` / `purchased_on` は `YYYY-MM-DD`、それ以外の日時はUTCの
  `YYYY-MM-DD HH:MM:SS` で統一しています。

テーブル定義は [migrations/0001_init.sql](migrations/0001_init.sql) と
[src/db/schema.ts](src/db/schema.ts) を参照してください。

---

## ディレクトリ構成

```
src/
  index.ts                  Honoアプリのエントリポイント（ルーティング）
  types.ts                  バインディングの型
  db/
    schema.ts               Drizzleスキーマ定義
    client.ts               D1クライアント初期化
  routes/
    households.ts           household作成・詳細・メンバー
    storageLocations.ts     保存場所
    foodCatalog.ts          食材カタログ検索
    photos.ts               画像アップロード・配信
    recognition.ts          認識ジョブ・候補・確定
    inventory.ts            在庫CRUD・消費・廃棄
    events.ts               履歴・集計
    recipes.ts              レシピ提案
  services/
    recognitionService.ts   Gemini画像認識
    recipeService.ts        Geminiレシピ提案
    inventoryService.ts     在庫ロット生成・イベント追記
    r2Service.ts            R2アップロード/取得/署名付きURL
  middleware/
    auth.ts                 簡易認証
    snakeCase.ts            レスポンスキーのsnake_case化
  lib/
    geminiClient.ts         Gemini API呼び出しの共通ラッパー
    validators.ts           Zodスキーマとパースヘルパー
    access.ts               householdメンバーシップの検証
    errors.ts               ApiErrorとエラーハンドラ
    datetime.ts             日付ユーティリティ
    normalize.ts            食材名の正規化
    id.ts                   UUID生成
migrations/                 D1マイグレーション
test/                       統合テスト
```

---

## テスト

```bash
npm test
```

Miniflare上で実サーバーと同じD1/R2バインディングを使い、
マイグレーション適用済みのDBに対して53件の統合テストを実行します。
Gemini APIの呼び出しは `vi.stubGlobal('fetch', ...)` で差し替えているため、
実際のAPIキーやネットワークは不要です。

カバーしている主なシナリオ:

- 認証（401、トークンからのユーザー自動作成）
- household作成・メンバー追加・権限（403、owner限定操作、invited状態）
- 保存場所、食材カタログ検索（表記ゆれの正規化を含む）
- 在庫の登録・期限順ソート・フィルタ・修正・消費・廃棄と各イベントの記録
- 履歴APIの集計値と期間フィルタ
- 画像アップロード → R2保存 → 署名付きURLでの取得、署名改竄時の挙動
- 画像認識ジョブの成功／429／JSONパース失敗、候補の修正と確定→在庫登録
- レシピ提案（プロンプトへの食材リスト埋め込みとレート制限時の429）

---

## デプロイ

```bash
npm run deploy
```

デプロイ前に、本番D1へのマイグレーション適用（`npm run db:migrate:remote`）と
シークレット登録（`GEMINI_API_KEY`, `PHOTO_URL_SECRET`）を済ませてください。
