-- 회사별 무료 '공고 가져오기' 사용 횟수 플랫폼 표. 테넌트 표가 아니다(RLS 없음, db.admin 으로만).
CREATE TABLE IF NOT EXISTS collect_credits (
  workspace_id uuid PRIMARY KEY,
  used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
