-- 「開封済み」機能の追加。
-- 未開封の消費期限とは別に、開封後の実質的な期限をカテゴリ別の固定ルールで再計算する。

ALTER TABLE inventory_lots ADD COLUMN opened_at TEXT;

-- inventory_events.event_type の CHECK 制約に 'opened' を追加する。
-- SQLite は CHECK 制約を直接変更できないため、テーブルを再作成する。
CREATE TABLE inventory_events_new (
  id TEXT PRIMARY KEY,
  inventory_lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('created','adjusted','consumed','discarded','opened')),
  quantity REAL NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO inventory_events_new
  (id, inventory_lot_id, household_id, event_type, quantity, actor_user_id, note, occurred_at)
  SELECT id, inventory_lot_id, household_id, event_type, quantity, actor_user_id, note, occurred_at
  FROM inventory_events;

DROP TABLE inventory_events;
ALTER TABLE inventory_events_new RENAME TO inventory_events;

CREATE INDEX events_history_idx ON inventory_events (household_id, occurred_at);
