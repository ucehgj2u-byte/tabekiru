-- MVP初期スキーマ（10テーブル）
-- 日付は YYYY-MM-DD 文字列、日時は UTC の datetime('now') 文字列で保存する。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  status TEXT NOT NULL CHECK (status IN ('active','invited')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE storage_locations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fridge','freezer','pantry')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE food_catalog (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  category TEXT,
  default_unit TEXT,
  normalized_name TEXT NOT NULL
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploaded','processed','failed')) DEFAULT 'uploaded',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE inventory_lots (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  food_catalog_id TEXT REFERENCES food_catalog(id),
  display_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  location_id TEXT REFERENCES storage_locations(id),
  purchased_on TEXT,
  expires_on TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','consumed','discarded')) DEFAULT 'active',
  source TEXT NOT NULL CHECK (source IN ('manual','scan')),
  photo_id TEXT REFERENCES photos(id),
  added_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 追記専用テーブル（UPDATE/DELETEは行わない）
CREATE TABLE inventory_events (
  id TEXT PRIMARY KEY,
  inventory_lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('created','adjusted','consumed','discarded')),
  quantity REAL NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recognition_jobs (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES photos(id),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed')) DEFAULT 'pending',
  model_name TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE recognition_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES recognition_jobs(id),
  detected_name TEXT NOT NULL,
  confidence REAL,
  suggested_quantity REAL,
  suggested_unit TEXT,
  bounding_box_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')) DEFAULT 'pending',
  corrected_name TEXT,
  inventory_lot_id TEXT REFERENCES inventory_lots(id)
);

CREATE INDEX inventory_expiry_idx ON inventory_lots (household_id, status, expires_on);
CREATE INDEX inventory_location_idx ON inventory_lots (household_id, location_id, status);
CREATE INDEX events_history_idx ON inventory_events (household_id, occurred_at);

-- 検索・参照でよく使う経路のための補助インデックス
CREATE INDEX food_catalog_normalized_idx ON food_catalog (normalized_name);
CREATE INDEX recognition_jobs_photo_idx ON recognition_jobs (photo_id);
CREATE INDEX recognition_candidates_job_idx ON recognition_candidates (job_id);
