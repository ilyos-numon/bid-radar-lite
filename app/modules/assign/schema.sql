-- 업무 분배: 공고별 담당자·상태
CREATE TABLE IF NOT EXISTS assign_items (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  bid_id text NOT NULL,
  assignee_id integer,
  status text NOT NULL CHECK(status IN ('review','go','pass')),
  note text,
  updated_at text NOT NULL,
  updated_by integer,
  PRIMARY KEY (workspace_id, bid_id)
);
