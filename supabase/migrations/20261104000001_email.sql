-- bid-radar-lite email alerts
-- Platform table (same pattern as rate_limits): no RLS, granted directly to app_worker,
-- hidden from the REST API. The app always filters by workspace_id.

-- source: app/core/email/schema.sql
-- 이메일 수신거부 (플랫폼 표)
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  workspace_id uuid NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);

alter table public.email_unsubscribes
  add constraint email_unsubscribes_ws_fk foreign key (workspace_id) references public.workspaces(id) on delete cascade;
revoke all on public.email_unsubscribes from public, anon, authenticated;
grant select, insert, update, delete on public.email_unsubscribes to app_worker;
