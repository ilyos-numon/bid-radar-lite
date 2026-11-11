-- 공고 요약
CREATE TABLE IF NOT EXISTS summary_items (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  bid_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('ready','unverified','no_text','failed')),
  what text,
  qualification text,
  documents text,
  evidence text,
  error text,
  updated_at text NOT NULL,
  PRIMARY KEY (workspace_id, bid_id)
);
