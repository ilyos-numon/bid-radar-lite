-- 내 회사: 회사 정보 한 행(회사별)과 공고별 판정
CREATE TABLE IF NOT EXISTS company_profile (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  name text NOT NULL DEFAULT '',
  licenses text NOT NULL DEFAULT '[]',
  regions text NOT NULL DEFAULT '[]',
  small_business integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id)
);

CREATE TABLE IF NOT EXISTS company_verdicts (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  bid_id text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('ok', 'check', 'no')),
  reasons text NOT NULL DEFAULT '[]',
  updated_at text NOT NULL,
  PRIMARY KEY (workspace_id, bid_id)
);
