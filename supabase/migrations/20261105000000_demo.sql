-- Demo (example company) platform table: which workspace is the example company and when it was last reset.
-- Platform table like rate_limits: no RLS, direct grants to app_worker, revoked from anon/authenticated.
-- source: app/core/demo/schema.sql (kept verbatim; tests/unit/demo-seed.test.mjs checks for drift)
CREATE TABLE IF NOT EXISTS demo_workspaces (
  workspace_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  staff_user_ids uuid[] NOT NULL DEFAULT '{}',
  seeded_at timestamptz,
  reset_count integer NOT NULL DEFAULT 0
);

alter table public.demo_workspaces add constraint demo_workspaces_ws_fk
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

revoke all on public.demo_workspaces from public, anon, authenticated;
grant select, insert, update, delete on public.demo_workspaces to app_worker;
