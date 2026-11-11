-- bid-radar-lite platform schema
-- Accounts, workspaces, memberships, invites, workspace keys (Supabase Vault) and audit log.
-- Business data stays in per-workspace SQLite files; this schema never stores it.
-- Every SECURITY DEFINER function pins search_path = '' and schema-qualifies all objects.
-- Secret values are never written to RAISE/NOTICE or audit_log.detail.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 60),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

create table public.memberships (
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  member_id integer not null,
  member_name text not null,
  created_at timestamptz default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_id_idx on public.memberships(user_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  token_hash text unique not null,
  member_id integer not null,
  member_name text not null,
  role text not null default 'staff',
  created_by uuid,
  created_at timestamptz default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz,
  used_by uuid
);

create table public.workspace_keys (
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text check (name in ('NARA_API_KEY', 'LLM_API_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'SUPPORT_API_BASE', 'SUPPORT_API_KEY')),
  secret_id uuid not null,
  masked text not null,
  updated_by uuid,
  updated_at timestamptz default now(),
  primary key (workspace_id, name)
);

create table public.audit_log (
  id bigserial primary key,
  at timestamptz default now(),
  user_id uuid,
  workspace_id uuid,
  event text not null,
  detail jsonb -- never contains key values
);

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so RLS policies on memberships do not recurse)
-- ---------------------------------------------------------------------------
create or replace function public.is_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_owner(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;
alter table public.workspace_keys enable row level security;
alter table public.audit_log enable row level security;

create policy workspaces_select on public.workspaces
  for select to authenticated using (public.is_member(id));
create policy memberships_select on public.memberships
  for select to authenticated using (public.is_member(workspace_id));
create policy invites_select on public.invites
  for select to authenticated using (public.is_owner(workspace_id));
create policy workspace_keys_select on public.workspace_keys
  for select to authenticated using (public.is_member(workspace_id));
create policy audit_log_select on public.audit_log
  for select to authenticated using (public.is_owner(workspace_id));

-- Table privileges: writes only through the functions below.
revoke all on public.workspaces, public.memberships, public.invites, public.workspace_keys, public.audit_log
  from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;
grant select on public.workspaces, public.memberships, public.invites, public.audit_log to authenticated;
-- secret_id is not readable by users (column grant)
grant select (name, masked, updated_at) on public.workspace_keys to authenticated;
grant all on public.workspaces, public.memberships, public.invites, public.workspace_keys, public.audit_log to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- Vault secret cleanup: removing a workspace_keys row (directly or through a
-- workspace cascade) deletes its Vault secret.
-- ---------------------------------------------------------------------------
create or replace function public.workspace_keys_delete_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets s where s.id = old.secret_id;
  return old;
end;
$$;

create trigger workspace_keys_delete_secret
  after delete on public.workspace_keys
  for each row execute function public.workspace_keys_delete_secret();

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER functions for authenticated users
-- ---------------------------------------------------------------------------
create or replace function public.create_workspace(p_name text, p_member_name text, p_max integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  -- serialize creations so the limit check cannot be raced
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('public.create_workspace'));
  if p_max is not null and (select count(*) from public.workspaces) >= p_max then
    raise exception 'WORKSPACE_LIMIT';
  end if;
  insert into public.workspaces (name, created_by) values (p_name, v_uid) returning id into v_id;
  insert into public.memberships (workspace_id, user_id, role, member_id, member_name)
    values (v_id, v_uid, 'owner', 1, p_member_name);
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, v_id, 'workspace.create', null);
  return v_id;
end;
$$;

create or replace function public.register_invite(p_ws uuid, p_token_hash text, p_member_id int, p_member_name text, p_role text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null or not public.is_owner(p_ws) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('owner', 'staff') then
    raise exception 'INVALID_ROLE';
  end if;
  insert into public.invites (workspace_id, token_hash, member_id, member_name, role, created_by)
    values (p_ws, p_token_hash, p_member_id, p_member_name, p_role, v_uid)
    returning id into v_id;
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, p_ws, 'invite.create', jsonb_build_object('member_id', p_member_id, 'role', p_role));
  return v_id;
end;
$$;

create or replace function public.accept_invite(p_token_hash text)
returns table (workspace_id uuid, member_id int, role text, member_name text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_inv public.invites%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  select i.* into v_inv
    from public.invites i
    where i.token_hash = p_token_hash and i.used_at is null and i.expires_at > now()
    for update;
  if not found then
    raise exception 'INVITE_INVALID';
  end if;
  insert into public.memberships (workspace_id, user_id, role, member_id, member_name)
    values (v_inv.workspace_id, v_uid, v_inv.role, v_inv.member_id, v_inv.member_name)
    on conflict on constraint memberships_pkey do nothing;
  update public.invites i set used_at = now(), used_by = v_uid where i.id = v_inv.id;
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, v_inv.workspace_id, 'invite.accept', jsonb_build_object('member_id', v_inv.member_id));
  return query
    select m.workspace_id, m.member_id, m.role, m.member_name
    from public.memberships m
    where m.workspace_id = v_inv.workspace_id and m.user_id = v_uid;
end;
$$;

create or replace function public.set_workspace_key(p_ws uuid, p_name text, p_value text, p_masked text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_secret uuid;
begin
  if v_uid is null or not public.is_owner(p_ws) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select k.secret_id into v_secret
    from public.workspace_keys k
    where k.workspace_id = p_ws and k.name = p_name
    for update;
  if v_secret is null then
    v_secret := vault.create_secret(p_value, null, 'workspace ' || p_ws::text || ' ' || p_name);
    insert into public.workspace_keys (workspace_id, name, secret_id, masked, updated_by, updated_at)
      values (p_ws, p_name, v_secret, p_masked, v_uid, now());
  else
    perform vault.update_secret(v_secret, p_value);
    update public.workspace_keys k
      set masked = p_masked, updated_by = v_uid, updated_at = now()
      where k.workspace_id = p_ws and k.name = p_name;
  end if;
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, p_ws, 'key.set', jsonb_build_object('name', p_name));
end;
$$;

create or replace function public.delete_workspace_key(p_ws uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_owner(p_ws) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  -- the after-delete trigger removes the Vault secret
  delete from public.workspace_keys k where k.workspace_id = p_ws and k.name = p_name;
  insert into public.audit_log (user_id, workspace_id, event, detail)
    values (v_uid, p_ws, 'key.delete', jsonb_build_object('name', p_name));
end;
$$;

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

-- ---------------------------------------------------------------------------
-- service_role only
-- ---------------------------------------------------------------------------
create or replace function public.get_workspace_key(p_ws uuid, p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from public.workspace_keys k
  join vault.decrypted_secrets ds on ds.id = k.secret_id
  where k.workspace_id = p_ws and k.name = p_name;
$$;

create or replace function public.list_workspaces_all()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.name from public.workspaces w order by w.created_at, w.id;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on function public.is_member(uuid) from public, anon;
revoke all on function public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated, service_role;
grant execute on function public.is_owner(uuid) to authenticated, service_role;

revoke all on function public.workspace_keys_delete_secret() from public, anon, authenticated;

revoke all on function public.create_workspace(text, text, integer) from public, anon;
revoke all on function public.register_invite(uuid, text, int, text, text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.set_workspace_key(uuid, text, text, text) from public, anon;
revoke all on function public.delete_workspace_key(uuid, text) from public, anon;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.create_workspace(text, text, integer) to authenticated, service_role;
grant execute on function public.register_invite(uuid, text, int, text, text) to authenticated, service_role;
grant execute on function public.accept_invite(text) to authenticated, service_role;
grant execute on function public.set_workspace_key(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.delete_workspace_key(uuid, text) to authenticated, service_role;
grant execute on function public.delete_my_account() to authenticated, service_role;

revoke all on function public.get_workspace_key(uuid, text) from public, anon, authenticated;
revoke all on function public.list_workspaces_all() from public, anon, authenticated;
grant execute on function public.get_workspace_key(uuid, text) to service_role;
grant execute on function public.list_workspaces_all() to service_role;
