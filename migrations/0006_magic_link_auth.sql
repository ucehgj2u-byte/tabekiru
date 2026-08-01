-- マジックリンクログイン用のワンタイムトークン。
-- 生トークンは保存せず、SHA-256ハッシュ(token_hash)のみを保存する。

CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX magic_link_tokens_token_hash_idx ON magic_link_tokens (token_hash);
