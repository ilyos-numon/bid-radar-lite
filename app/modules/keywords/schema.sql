CREATE TABLE IF NOT EXISTS keywords_synonyms (
  workspace_id uuid NOT NULL DEFAULT (current_setting('app.workspace_id', true))::uuid,
  word text NOT NULL,
  for_keyword text,
  why text,
  status text NOT NULL CHECK(status IN ('suggested','accepted','rejected')),
  created_at text,
  PRIMARY KEY (workspace_id, word)
);
