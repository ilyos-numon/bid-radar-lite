-- 데모(예시) 회사 플랫폼 표: 어느 회사가 예시 회사인지와 마지막 초기화. 테넌트 표가 아니다(RLS 없음, db.admin 으로만).
CREATE TABLE IF NOT EXISTS demo_workspaces (
  workspace_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  staff_user_ids uuid[] NOT NULL DEFAULT '{}',
  seeded_at timestamptz,
  reset_count integer NOT NULL DEFAULT 0
);
