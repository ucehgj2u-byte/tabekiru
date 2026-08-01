-- レシピ提案の履歴を保存する。
-- 「何が提案されたか」を後から見返せるようにするための追記専用テーブル。
-- used_lot_ids / recipes は JSON文字列として保存する（提案時点のスナップショット。
-- 在庫が消費・削除されても履歴の内容は変わらない）。

CREATE TABLE recipe_suggestions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  model_name TEXT NOT NULL,
  -- 'selected' = ユーザーが在庫一覧から選んだ食材 / 'auto' = 期限が近い順の自動選択
  selection_mode TEXT NOT NULL CHECK (selection_mode IN ('selected', 'auto')),
  -- 提案時点で使った食材の一覧（inventory_lot_id, display_name, expires_on の配列をJSON化）
  based_on_json TEXT NOT NULL,
  -- Geminiが返したレシピ配列（title, used_ingredients, steps, missing_ingredients）をJSON化
  recipes_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX recipe_suggestions_household_idx
  ON recipe_suggestions (household_id, created_at);
