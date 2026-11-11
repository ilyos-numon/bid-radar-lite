-- bid-radar-lite SaaS platform
-- Tenant isolation for the business tables created by 20261103000000_tenant_tables.sql:
-- the app connects as app_worker, sets app.workspace_id per request, and forced RLS
-- limits every row to that workspace. Also: pgmq job queue, shared rate limit table,
-- remove_member RPC and the delete_my_account extension.
-- Every SECURITY DEFINER function pins search_path = '' and schema-qualifies all objects.

-- ---------------------------------------------------------------------------
-- ① Job queue
-- ---------------------------------------------------------------------------
create extension if not exists pgmq;
select pgmq.create('jobs');

-- ---------------------------------------------------------------------------
-- ② App role (password is set outside migrations: seed.sql locally, by the operator in the cloud)
-- Roles are cluster-wide, so a reset database may still have it.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'app_worker') then
    create role app_worker nologin noinherit nobypassrls;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- ③ Tenant tables: workspace FK, forced RLS, app_worker policy and grants
-- tenant tables: settings members sources source_runs bids bid_texts matches notifications bid_details bid_changes collect_days bid_links job_runs notification_deliveries assign_items company_profile company_verdicts history_results interest_items interest_checks interest_reminders keywords_synonyms summary_items support_items support_runs
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'settings', 'members', 'sources', 'source_runs', 'bids', 'bid_texts', 'matches', 'notifications',
    'bid_details', 'bid_changes', 'collect_days', 'bid_links', 'job_runs', 'notification_deliveries',
    'assign_items', 'company_profile', 'company_verdicts', 'history_results',
    'interest_items', 'interest_checks', 'interest_reminders', 'keywords_synonyms',
    'summary_items', 'support_items', 'support_runs'
  ]
  loop
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id) references public.workspaces(id) on delete cascade',
      t, t || '_ws_fk');
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy %I on public.%I for all to app_worker'
      || ' using (workspace_id = (current_setting(''app.workspace_id'', true))::uuid)'
      || ' with check (workspace_id = (current_setting(''app.workspace_id'', true))::uuid)',
      t || '_app_worker', t);
    -- business data is never served through the REST API
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to app_worker', t);
  end loop;
end;
$$;
grant usage, select on all sequences in schema public to app_worker;

-- ---------------------------------------------------------------------------
-- ④ Membership lookups for the app (read only, own workspace)
-- ---------------------------------------------------------------------------
grant select on public.memberships, public.invites to app_worker;
create policy memberships_app_worker on public.memberships
  for select to app_worker using (workspace_id = (current_setting('app.workspace_id', true))::uuid);
create policy invites_app_worker on public.invites
  for select to app_worker using (workspace_id = (current_setting('app.workspace_id', true))::uuid);

-- ---------------------------------------------------------------------------
-- ⑤ Shared rate limit store (not a tenant table)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key text primary key,
  hits integer not null,
  reset_at timestamptz not null
);
revoke all on public.rate_limits from public, anon, authenticated;
grant all on public.rate_limits to app_worker;

-- ---------------------------------------------------------------------------
-- ⑥ Queue access for app_worker (signatures as installed by pgmq 1.5.1)
-- ---------------------------------------------------------------------------
grant usage on schema pgmq to app_worker;
grant execute on function
  pgmq.send(text, jsonb, integer),
  pgmq.send_batch(text, jsonb[], integer),
  pgmq.read(text, integer, integer, jsonb),
  pgmq.delete(text, bigint),
  pgmq.archive(text, bigint)
  to app_worker;
grant select on pgmq.q_jobs, pgmq.a_jobs to app_worker;
-- pgmq functions run as the caller, so the queue tables need row privileges too
grant insert, update, delete on pgmq.q_jobs to app_worker;
grant insert on pgmq.a_jobs to app_worker;
grant usage, select on sequence pgmq.q_jobs_msg_id_seq to app_worker;

-- ---------------------------------------------------------------------------
-- ⑦ remove_member: owner removes a member (joined or invited) from a workspace
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(p_ws uuid, p_member_id int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), '') = 'service_role';
  v_target public.memberships%rowtype;
begin
  if not v_service and (v_uid is null or not public.is_owner(p_ws)) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select m.* into v_target
    from public.memberships m
    where m.workspace_id = p_ws and m.member_id = p_member_id
    for update;
  if found then
    if v_target.user_id = v_uid then
      raise exception 'CANNOT_REMOVE_SELF';
    end if;
    if v_target.role = 'owner' then
      raise exception 'CANNOT_REMOVE_OWNER';
    end if;
  end if;
  delete from public.memberships m where m.workspace_id = p_ws and m.member_id = p_member_id;
  delete from public.invites i where i.workspace_id = p_ws and i.member_id = p_member_id and i.used_at is null;
  update public.assign_items a set assignee_id = null
    where a.workspace_id = p_ws and a.assignee_id = p_member_id;
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, p_ws, 'member.remove', jsonb_build_object('member_id', p_member_id));
end;
$$;

revoke all on function public.remove_member(uuid, int) from public, anon;
grant execute on function public.remove_member(uuid, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ⑧ delete_my_account: also release assignments and personal references
-- (business rows of owned workspaces go with the workspace FK cascade)
-- ---------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  update public.assign_items a set assignee_id = null
    from public.memberships m
    where m.user_id = v_uid and a.workspace_id = m.workspace_id and a.assignee_id = m.member_id;
  update public.invites i set created_by = null where i.created_by = v_uid;
  update public.invites i set used_by = null where i.used_by = v_uid;
  update public.audit_log l set user_id = null where l.user_id = v_uid;
  -- workspaces owned by the caller: cascade removes memberships, invites, keys (and their Vault secrets)
  delete from public.workspaces w
    where w.id in (
      select m.workspace_id from public.memberships m
      where m.user_id = v_uid and m.role = 'owner'
    );
  delete from public.memberships m where m.user_id = v_uid;
  delete from auth.users u where u.id = v_uid;
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, null, 'account.delete', null);
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ⑨ Schema access
-- ---------------------------------------------------------------------------
grant usage on schema public to app_worker;
