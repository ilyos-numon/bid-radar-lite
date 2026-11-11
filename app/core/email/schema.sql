-- 이메일 수신거부 (플랫폼 표)
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  workspace_id uuid NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);
