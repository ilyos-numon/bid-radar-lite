-- Free collect credits platform table: how many free manual collects each workspace has used.
-- Platform table like rate_limits: no RLS, direct grants to app_worker, revoked from anon/authenticated.
-- source: app/core/billing/credits.sql (kept verbatim; tests/unit/credits.test.mjs checks for drift)
CREATE TABLE IF NOT EXISTS collect_credits (
  workspace_id uuid PRIMARY KEY,
  used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

alter table public.collect_credits add constraint collect_credits_ws_fk
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

revoke all on public.collect_credits from public, anon, authenticated;
grant all on public.collect_credits to app_worker;
