-- Unipakt shared tasks, per-profile sticky notes, and per-profile Supabase PINs.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.tasks (
  id text primary key,
  title text not null check (char_length(title) between 1 and 120),
  detail text not null default '',
  assignee text not null default 'Akif',
  due date,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.tasks enable row level security;
revoke all on public.tasks from public, anon, authenticated;
drop policy if exists "team can manage tasks" on public.tasks;

create table if not exists public.profile_notes (
  profile_id text primary key check (profile_id in ('akif','mehmet','ugur')),
  body text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profile_notes enable row level security;
revoke all on public.profile_notes from public, anon, authenticated;
drop policy if exists "team can manage profile notes" on public.profile_notes;

create table if not exists public.profile_access_pins (
  profile_id text primary key check (profile_id in ('akif','mehmet','ugur')),
  pin_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.profile_access_pins enable row level security;
revoke all on public.profile_access_pins from public, anon, authenticated;

create table if not exists public.app_access_sessions (
  token_hash text primary key,
  expires_at timestamptz not null,
  profile_id text check (profile_id in ('akif','mehmet','ugur'))
);
alter table public.app_access_sessions add column if not exists profile_id text;
alter table public.app_access_sessions enable row level security;
revoke all on public.app_access_sessions from public, anon, authenticated;

create or replace function public._has_valid_pin_session(p_session_token text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select p_session_token is not null and exists (
    select 1 from public.app_access_sessions
    where token_hash = encode(digest(p_session_token, 'sha256'), 'hex')
      and expires_at > now()
      and profile_id is not null
  );
$$;
revoke all on function public._has_valid_pin_session(text) from public, anon, authenticated;

create or replace function public._pin_session_profile(p_session_token text)
returns text language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select profile_id from public.app_access_sessions
  where p_session_token is not null
    and token_hash = encode(digest(p_session_token, 'sha256'), 'hex')
    and expires_at > now()
  limit 1;
$$;
revoke all on function public._pin_session_profile(text) from public, anon, authenticated;

-- Remove the previous shared-PIN entry points so they cannot create unscoped sessions.
drop function if exists public.has_access_pin();
drop function if exists public.setup_access_pin(text);
drop function if exists public.verify_access_pin(text);

create or replace function public.has_access_pin(p_profile_id text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp
as $$ select exists (select 1 from public.profile_access_pins where profile_id=p_profile_id); $$;

create or replace function public.setup_access_pin(p_profile_id text, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_token text;
begin
  if p_profile_id not in ('akif','mehmet','ugur') then raise exception 'Invalid profile'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must contain four digits'; end if;
  insert into public.profile_access_pins(profile_id, pin_hash)
  values (p_profile_id, crypt(p_pin, gen_salt('bf', 10))) on conflict (profile_id) do nothing;
  if not found then return null; end if;
  v_token := encode(gen_random_bytes(32), 'hex');
  delete from public.app_access_sessions where expires_at <= now();
  insert into public.app_access_sessions(token_hash, expires_at, profile_id)
  values (encode(digest(v_token, 'sha256'), 'hex'), now() + interval '12 hours', p_profile_id);
  return v_token;
end;
$$;

create or replace function public.verify_access_pin(p_profile_id text, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_hash text; v_token text;
begin
  if p_profile_id not in ('akif','mehmet','ugur') then return null; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then return null; end if;
  select pin_hash into v_hash from public.profile_access_pins where profile_id=p_profile_id;
  if v_hash is null or crypt(p_pin, v_hash) <> v_hash then return null; end if;
  v_token := encode(gen_random_bytes(32), 'hex');
  delete from public.app_access_sessions where expires_at <= now();
  insert into public.app_access_sessions(token_hash, expires_at, profile_id)
  values (encode(digest(v_token, 'sha256'), 'hex'), now() + interval '12 hours', p_profile_id);
  return v_token;
end;
$$;

create or replace function public.change_access_pin(p_new_pin text, p_session_token text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4}$' then raise exception 'PIN must contain four digits'; end if;
  if not public._has_valid_pin_session(p_session_token) then return false; end if;
  update public.profile_access_pins set pin_hash = crypt(p_new_pin, gen_salt('bf', 10)), updated_at = now()
  where profile_id=public._pin_session_profile(p_session_token);
  return found;
end;
$$;

create or replace function public.list_tasks(p_session_token text)
returns setof public.tasks language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  return query select * from public.tasks order by created_at desc;
end;
$$;

create or replace function public.upsert_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  insert into public.tasks(id,title,detail,assignee,due,done,created_at,completed_at)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''), coalesce(p_task->>'assignee','Akif'),
    nullif(p_task->>'due','')::date, coalesce((p_task->>'done')::boolean,false),
    coalesce(nullif(p_task->>'created_at','')::timestamptz,now()), nullif(p_task->>'completed_at','')::timestamptz
  )
  on conflict (id) do update set title=excluded.title, detail=excluded.detail, assignee=excluded.assignee,
    due=excluded.due, done=excluded.done, created_at=excluded.created_at, completed_at=excluded.completed_at;
  return true;
end;
$$;

create or replace function public.update_task_state(p_session_token text, p_task_id text, p_done boolean, p_completed_at timestamptz)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  update public.tasks set done=p_done, completed_at=p_completed_at where id=p_task_id;
  return found;
end;
$$;

create or replace function public.delete_task(p_session_token text, p_task_id text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  delete from public.tasks where id=p_task_id;
  return found;
end;
$$;

create or replace function public.get_profile_note(p_session_token text, p_profile_id text)
returns text language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare v_body text;
begin
  if public._pin_session_profile(p_session_token) is distinct from p_profile_id then raise exception 'Access denied'; end if;
  select body into v_body from public.profile_notes where profile_id=p_profile_id;
  return coalesce(v_body,'');
end;
$$;

create or replace function public.save_profile_note(p_session_token text, p_profile_id text, p_body text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if public._pin_session_profile(p_session_token) is distinct from p_profile_id then raise exception 'Access denied'; end if;
  if p_profile_id not in ('akif','mehmet','ugur') or char_length(p_body) > 600 then raise exception 'Invalid note'; end if;
  insert into public.profile_notes(profile_id,body,updated_at) values(p_profile_id,coalesce(p_body,''),now())
  on conflict(profile_id) do update set body=excluded.body,updated_at=excluded.updated_at;
  return true;
end;
$$;

create or replace function public.clear_profile_note(p_session_token text, p_profile_id text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if public._pin_session_profile(p_session_token) is distinct from p_profile_id then raise exception 'Access denied'; end if;
  delete from public.profile_notes where profile_id=p_profile_id;
  return true;
end;
$$;

revoke all on function public.has_access_pin(text) from public, authenticated;
revoke all on function public.setup_access_pin(text,text) from public, authenticated;
revoke all on function public.verify_access_pin(text,text) from public, authenticated;
revoke all on function public.change_access_pin(text,text) from public, authenticated;
revoke all on function public.list_tasks(text) from public, authenticated;
revoke all on function public.upsert_task(text,jsonb) from public, authenticated;
revoke all on function public.update_task_state(text,text,boolean,timestamptz) from public, authenticated;
revoke all on function public.delete_task(text,text) from public, authenticated;
revoke all on function public.get_profile_note(text,text) from public, authenticated;
revoke all on function public.save_profile_note(text,text,text) from public, authenticated;
revoke all on function public.clear_profile_note(text,text) from public, authenticated;
grant execute on function public.has_access_pin(text) to anon;
grant execute on function public.setup_access_pin(text,text) to anon;
grant execute on function public.verify_access_pin(text,text) to anon;
grant execute on function public.change_access_pin(text,text) to anon;
grant execute on function public.list_tasks(text) to anon;
grant execute on function public.upsert_task(text,jsonb) to anon;
grant execute on function public.update_task_state(text,text,boolean,timestamptz) to anon;
grant execute on function public.delete_task(text,text) to anon;
grant execute on function public.get_profile_note(text,text) to anon;
grant execute on function public.save_profile_note(text,text,text) to anon;
grant execute on function public.clear_profile_note(text,text) to anon;


-- Sonraki adımlar: supabase/security_hardening.sql, ardından supabase/v2_features.sql
-- (kod deneme sınırı, görev doğrulaması, add_task).
