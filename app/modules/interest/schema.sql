-- 관심 공고. 테이블명은 interest_ 접두
CREATE TABLE IF NOT EXISTS interest_items (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  bid_id text NOT NULL,
  member_id integer,
  created_at text NOT NULL,
  note text,
  PRIMARY KEY (workspace_id, bid_id)
);
CREATE TABLE IF NOT EXISTS interest_checks (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  bid_id text NOT NULL,
  item integer NOT NULL,
  checked integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, bid_id, item)
);
CREATE TABLE IF NOT EXISTS interest_reminders (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  bid_id text NOT NULL,
  day integer NOT NULL,
  sent_date text NOT NULL,
  PRIMARY KEY (workspace_id, bid_id, day)
);
