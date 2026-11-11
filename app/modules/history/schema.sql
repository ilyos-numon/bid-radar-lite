-- 지난 개찰: 검색어·기간별 조회 결과 캐시 (24시간)
CREATE TABLE IF NOT EXISTS history_results (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  query_key text NOT NULL,
  fetched_at text,
  rows text NOT NULL,
  PRIMARY KEY (workspace_id, query_key)
);
