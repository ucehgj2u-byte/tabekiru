-- 食材カテゴリ（野菜・肉・魚など）と、画像認識による期限推定の結果を保持する列を追加する。

-- 在庫のカテゴリ。既存行は NULL（=未分類）のままで良い。
ALTER TABLE inventory_lots ADD COLUMN category TEXT;

-- 認識候補に、AIが推定したカテゴリと消費期限を持たせる。
ALTER TABLE recognition_candidates ADD COLUMN suggested_category TEXT;
ALTER TABLE recognition_candidates ADD COLUMN suggested_expires_on TEXT;

-- 期限の根拠。'printed' = パッケージの印字を読み取った / 'estimated' = 一般的な日持ちからの推定
ALTER TABLE recognition_candidates ADD COLUMN expiry_source TEXT;

CREATE INDEX inventory_category_idx ON inventory_lots (household_id, category, status);
