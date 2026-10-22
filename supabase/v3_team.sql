-- =============================================================================
-- Unipakt Görev Masası — v3: ekip, roller, kişisel ekranlar, pano, projeler
--
-- v2_features.sql'den SONRA, Supabase SQL Editor'da BİR KEZ çalıştırın.
-- Tekrar çalıştırmak zararsızdır; görevler, notlar ve kodlar korunur.
--
-- Roller
--   owner  : Akif. Herkese görev atar, Merkez üyesi ekler, rolleri yönetir.
--   merkez : Mehmet, Uğur. Kendine ve Yönetim Kurulu'na görev atar,
--            Yönetim Kurulu üyesi ekler. Herkesin görevlerini görür.
--   yk     : Yönetim Kurulu. Yalnızca kendi görevlerini görür,
--            yalnızca kendine görev ekleyebilir.
-- "Tüm Merkez" (assignee_id = 'merkez'): Merkez'in ortak işi. Görev olarak
-- yalnızca owner atar; Meet olarak Merkez'in hepsi oluşturabilir.
--
-- Giriş kodu artık 6 hanelidir. Eski 4 haneli kodlar bir kez daha çalışır,
-- ardından kişi 6 haneli yeni kodunu belirlemek zorundadır.
-- =============================================================================

-- ---------- Kişiler ----------
create table if not exists public.profiles (
  id              text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name            text not null check (char_length(trim(name)) between 1 and 40),
  initial         text not null check (char_length(initial) between 1 and 2),
  role            text not null check (role in ('owner','merkez','yk')),
  color           text not null default '#8e8c9a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  active          boolean not null default true,
  must_change_pin boolean not null default false,
  created_at      timestamptz not null default now(),
  created_by      text
);
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated;

insert into public.profiles(id, name, initial, role, color, must_change_pin) values
  ('akif',   'Akif',   'A', 'owner',  '#8b7cf0', true),
  ('mehmet', 'Mehmet', 'M', 'merkez', '#45b5a6', true),
  ('ugur',   'Uğur',   'U', 'merkez', '#f0a75f', true)
on conflict (id) do nothing;

-- Eski "yalnızca akif/mehmet/ugur" kısıtlarını kaldır, yerine kişiler tablosuna bağla
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in ('public.profile_access_pins'::regclass, 'public.profile_notes'::regclass,
                         'public.app_access_sessions'::regclass, 'public.pin_attempts'::regclass)
      and pg_get_constraintdef(c.oid) ilike '%akif%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profile_access_pins_profile_fk') then
    alter table public.profile_access_pins add constraint profile_access_pins_profile_fk
      foreign key (profile_id) references public.profiles(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profile_notes_profile_fk') then
    alter table public.profile_notes add constraint profile_notes_profile_fk
      foreign key (profile_id) references public.profiles(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pin_attempts_profile_fk') then
    alter table public.pin_attempts add constraint pin_attempts_profile_fk
      foreign key (profile_id) references public.profiles(id) on delete cascade;
  end if;
end $$;

-- ---------- Görev alanları ----------
alter table public.tasks add column if not exists assignee_id text;
alter table public.tasks add column if not exists status      text not null default 'todo';
alter table public.tasks add column if not exists project     text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_status_check') then
    alter table public.tasks add constraint tasks_status_check check (status in ('todo','doing','waiting','done'));
  end if;
end $$;

-- Mevcut görevleri yeni alanlara taşı (yalnızca boş olanlar)
update public.tasks set assignee_id = case lower(trim(assignee))
    when 'akif' then 'akif' when 'mehmet' then 'mehmet'
    when 'uğur' then 'ugur' when 'ugur' then 'ugur'
    else 'merkez' end
  where assignee_id is null;
update public.tasks set assignee = 'Tüm Merkez' where assignee_id = 'merkez' and assignee <> 'Tüm Merkez';
update public.tasks set status = 'done' where done and status <> 'done';
update public.tasks set status = 'todo' where not done and status = 'done';

-- ---------- Yardımcılar ----------
create or replace function public._actor(p_session_token text)
returns public.profiles language sql stable security definer
set search_path = public, extensions, pg_temp
as $$
  select p.* from public.profiles p
  where p.id = public._pin_session_profile(p_session_token) and p.active;
$$;
revoke all on function public._actor(text) from public, anon, authenticated;

-- Bu kişi bu sorumluya, bu türde kayıt atayabilir mi?
create or replace function public._can_assign(p_actor public.profiles, p_assignee text, p_kind text)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select case
    when p_assignee = 'merkez' then p_actor.role = 'owner' or (p_actor.role = 'merkez' and p_kind = 'meet')
    when p_actor.role = 'owner' then exists (select 1 from public.profiles where id = p_assignee and active)
    when p_actor.role = 'merkez' then p_assignee = p_actor.id
      or exists (select 1 from public.profiles where id = p_assignee and active and role = 'yk')
    else p_assignee = p_actor.id
  end;
$$;
revoke all on function public._can_assign(public.profiles, text, text) from public, anon, authenticated;

-- Bu kişi bu görevi görebilir mi?
create or replace function public._can_see(p_actor public.profiles, p_task public.tasks)
returns boolean language sql stable
set search_path = public, pg_temp
as $$
  select p_actor.role in ('owner','merkez') or p_task.assignee_id = p_actor.id;
$$;
revoke all on function public._can_see(public.profiles, public.tasks) from public, anon, authenticated;

-- Bu kişi bu görevin içeriğini düzenleyebilir / silebilir mi?
create or replace function public._can_edit(p_actor public.profiles, p_task public.tasks)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select case p_actor.role
    when 'owner' then true
    when 'merkez' then p_task.created_by = p_actor.id or p_task.assignee_id = p_actor.id
      or exists (select 1 from public.profiles where id = p_task.assignee_id and role = 'yk')
    else p_task.created_by = p_actor.id and p_task.assignee_id = p_actor.id
  end;
$$;
revoke all on function public._can_edit(public.profiles, public.tasks) from public, anon, authenticated;

create or replace function public._assignee_name(p_assignee text)
returns text language sql stable security definer
set search_path = public, pg_temp
as $$
  select case when p_assignee = 'merkez' then 'Tüm Merkez'
    else (select name from public.profiles where id = p_assignee) end;
$$;
revoke all on function public._assignee_name(text) from public, anon, authenticated;

-- Doğrulama: v2 kurallarına sorumlu kimliği, durum ve proje eklenir
create or replace function public._validate_task(p_task jsonb)
returns void language plpgsql immutable
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_task->>'id','') !~ '^[A-Za-z0-9._:-]{1,64}$' then raise exception 'INVALID_TASK:id'; end if;
  if char_length(trim(coalesce(p_task->>'title',''))) not between 1 and 120 then raise exception 'INVALID_TASK:title'; end if;
  if char_length(coalesce(p_task->>'detail','')) > 400 then raise exception 'INVALID_TASK:detail'; end if;
  if coalesce(p_task->>'priority','normal') not in ('normal','urgent') then raise exception 'INVALID_TASK:priority'; end if;
  if nullif(p_task->>'due','') is not null and (p_task->>'due') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_TASK:due'; end if;
  if coalesce(p_task->>'kind','task') not in ('task','meet') then raise exception 'INVALID_TASK:kind'; end if;
  if coalesce(p_task->>'kind','task') = 'meet' then
    if nullif(p_task->>'due','') is null then raise exception 'INVALID_TASK:meet_date'; end if;
    if coalesce(p_task->>'meet_time','') !~ '^([01]\d|2[0-3]):[0-5]\d(:00)?$' then raise exception 'INVALID_TASK:meet_time'; end if;
  end if;
  if nullif(p_task->>'meet_link','') is not null
     and ((p_task->>'meet_link') !~ '^https://[^\s"''<>]+$' or char_length(p_task->>'meet_link') > 300) then
    raise exception 'INVALID_TASK:meet_link';
  end if;
  if coalesce(p_task->>'status','todo') not in ('todo','doing','waiting','done') then raise exception 'INVALID_TASK:status'; end if;
  if char_length(coalesce(p_task->>'project','')) > 40 then raise exception 'INVALID_TASK:project'; end if;
  if coalesce(p_task->>'assignee_id','') !~ '^[a-z0-9-]{2,40}$' then raise exception 'INVALID_TASK:assignee'; end if;
end;
$$;
revoke all on function public._validate_task(jsonb) from public, anon, authenticated;

-- ---------- Kişiler: giriş ekranı ve oturum ----------
-- Giriş ekranındaki profil listesi (rol bilgisi verilmez)
create or replace function public.list_login_profiles()
returns table(id text, name text, initial text, color text)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select id, name, initial, color from public.profiles where active
  order by case role when 'owner' then 0 when 'merkez' then 1 else 2 end, created_at, name;
$$;

create or replace function public.my_session(p_session_token text)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles;
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  return jsonb_build_object('id', v.id, 'name', v.name, 'initial', v.initial, 'role', v.role,
                            'color', v.color, 'must_change_pin', v.must_change_pin);
end;
$$;

create or replace function public.list_team(p_session_token text)
returns table(id text, name text, initial text, role text, color text, active boolean)
language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles;
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  return query select p.id, p.name, p.initial, p.role, p.color, p.active from public.profiles p
    where p.active or v.role in ('owner','merkez')
    order by case p.role when 'owner' then 0 when 'merkez' then 1 else 2 end, p.created_at, p.name;
end;
$$;

-- ---------- Giriş kodu (6 hane; eski 4 haneliler bir kez daha geçer) ----------
create or replace function public.has_access_pin(p_profile_id text)
returns boolean language sql stable security definer
set search_path = public, extensions, pg_temp
as $$ select exists (select 1 from public.profile_access_pins a join public.profiles p on p.id = a.profile_id
                     where a.profile_id = p_profile_id and p.active); $$;

create or replace function public.setup_access_pin(p_profile_id text, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_token text;
begin
  if not exists (select 1 from public.profiles where id = p_profile_id and active) then raise exception 'Invalid profile'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then raise exception 'PIN must contain six digits'; end if;
  insert into public.profile_access_pins(profile_id, pin_hash)
  values (p_profile_id, crypt(p_pin, gen_salt('bf', 10))) on conflict (profile_id) do nothing;
  if not found then return null; end if;
  update public.profiles set must_change_pin = false where id = p_profile_id;
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
declare
  v_hash text; v_token text; v_att public.pin_attempts%rowtype; v_lock_minutes integer;
begin
  if not exists (select 1 from public.profiles where id = p_profile_id and active) then return null; end if;

  insert into public.pin_attempts(profile_id) values (p_profile_id) on conflict (profile_id) do nothing;
  select * into v_att from public.pin_attempts where profile_id = p_profile_id for update;
  if v_att.locked_until is not null and v_att.locked_until > now() then
    raise exception 'PIN_LOCKED:%', ceil(extract(epoch from (v_att.locked_until - now())) / 60)::int;
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then return null; end if;

  select pin_hash into v_hash from public.profile_access_pins where profile_id = p_profile_id;
  if v_hash is null or crypt(p_pin, v_hash) <> v_hash then
    v_att.failed := v_att.failed + 1;
    if v_att.failed % 5 = 0 then
      v_lock_minutes := least(15 * power(2, v_att.failed / 5 - 1)::int, 1440);
      update public.pin_attempts set failed = v_att.failed, locked_until = now() + make_interval(mins => v_lock_minutes)
        where profile_id = p_profile_id;
    else
      update public.pin_attempts set failed = v_att.failed where profile_id = p_profile_id;
    end if;
    return null;
  end if;

  update public.pin_attempts set failed = 0, locked_until = null where profile_id = p_profile_id;
  -- 6 haneden kısa eski kodlar: girişe izin ver ama değiştirmeyi zorunlu kıl
  if char_length(p_pin) < 6 then update public.profiles set must_change_pin = true where id = p_profile_id; end if;

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
declare v public.profiles;
begin
  if p_new_pin is null or p_new_pin !~ '^[0-9]{6}$' then raise exception 'PIN must contain six digits'; end if;
  v := public._actor(p_session_token);
  if v.id is null then return false; end if;
  update public.profile_access_pins set pin_hash = crypt(p_new_pin, gen_salt('bf', 10)), updated_at = now()
    where profile_id = v.id;
  if not found then
    insert into public.profile_access_pins(profile_id, pin_hash) values (v.id, crypt(p_new_pin, gen_salt('bf', 10)));
  end if;
  update public.profiles set must_change_pin = false where id = v.id;
  return true;
end;
$$;

-- ---------- Ekip yönetimi ----------
-- Yeni kişi: ekleyen 6 haneli bir ilk kod verir, kişi ilk girişte kendi kodunu belirler
create or replace function public.add_member(p_session_token text, p_name text, p_role text, p_initial_pin text)
returns text language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v public.profiles; v_id text; v_base text; v_name text := trim(coalesce(p_name,''));
  v_palette text[] := array['#e0607e','#5aa9e6','#7fc97f','#f2c14e','#c084fc','#4fd1c5','#f6ad55','#a3a3ff','#ff8fa3','#6ee7b7'];
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  if p_role not in ('merkez','yk') then raise exception 'INVALID_MEMBER:role'; end if;
  if v.role = 'yk' or (p_role = 'merkez' and v.role <> 'owner') then raise exception 'NOT_ALLOWED'; end if;
  if char_length(v_name) not between 1 and 40 then raise exception 'INVALID_MEMBER:name'; end if;
  if p_initial_pin is null or p_initial_pin !~ '^[0-9]{6}$' then raise exception 'INVALID_MEMBER:pin'; end if;
  if (select count(*) from public.profiles where active) >= 30 then raise exception 'INVALID_MEMBER:limit'; end if;

  v_base := regexp_replace(translate(lower(v_name), 'çğıöşüâîû', 'cgiosuaiu'), '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from left(v_base, 30));
  if char_length(v_base) < 2 then v_base := 'uye'; end if;
  v_id := v_base;
  while exists (select 1 from public.profiles where id = v_id) loop
    v_id := v_base || '-' || substr(encode(gen_random_bytes(3), 'hex'), 1, 4);
  end loop;

  insert into public.profiles(id, name, initial, role, color, must_change_pin, created_by)
  values (v_id, v_name, upper(left(v_name, 1)), p_role,
          v_palette[1 + (select count(*) from public.profiles)::int % array_length(v_palette, 1)], true, v.id);
  insert into public.profile_access_pins(profile_id, pin_hash) values (v_id, crypt(p_initial_pin, gen_salt('bf', 10)));
  return v_id;
end;
$$;

-- Kişiyi pasifleştirir / geri açar ve ilk kodunu sıfırlar
create or replace function public.update_member(p_session_token text, p_member_id text, p_active boolean, p_reset_pin text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles; t public.profiles;
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  select * into t from public.profiles where id = p_member_id;
  if t.id is null then raise exception 'INVALID_MEMBER:id'; end if;
  if t.id = v.id or t.role = 'owner' then raise exception 'NOT_ALLOWED'; end if;
  if v.role = 'yk' or (t.role = 'merkez' and v.role <> 'owner') then raise exception 'NOT_ALLOWED'; end if;
  if p_reset_pin is not null and p_reset_pin !~ '^[0-9]{6}$' then raise exception 'INVALID_MEMBER:pin'; end if;

  update public.profiles set active = coalesce(p_active, active),
    must_change_pin = case when p_reset_pin is not null then true else must_change_pin end
    where id = t.id;
  if p_reset_pin is not null then
    insert into public.profile_access_pins(profile_id, pin_hash) values (t.id, crypt(p_reset_pin, gen_salt('bf', 10)))
    on conflict (profile_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
    delete from public.pin_attempts where profile_id = t.id;
  end if;
  if p_active = false then
    delete from public.app_access_sessions where profile_id = t.id; -- açık oturumları kapat
  end if;
  return true;
end;
$$;

-- ---------- Görevler ----------
create or replace function public.list_tasks(p_session_token text)
returns setof public.tasks language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles;
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  return query select t.* from public.tasks t where public._can_see(v, t) order by t.created_at desc;
end;
$$;

create or replace function public.add_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles; v_kind text := coalesce(p_task->>'kind','task');
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  if not public._can_assign(v, p_task->>'assignee_id', v_kind) then raise exception 'NOT_ALLOWED'; end if;
  insert into public.tasks(id,title,detail,assignee,assignee_id,due,priority,status,project,done,created_at,completed_at,
                           created_by,updated_at,kind,meet_time,meet_link)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''),
    public._assignee_name(p_task->>'assignee_id'), p_task->>'assignee_id',
    nullif(p_task->>'due','')::date, coalesce(p_task->>'priority','normal'), 'todo', nullif(trim(p_task->>'project'),''),
    false, now(), null, v.id, now(), v_kind, nullif(p_task->>'meet_time','')::time, nullif(p_task->>'meet_link','')
  )
  on conflict (id) do nothing;
  return found;
end;
$$;

create or replace function public.update_task(p_session_token text, p_task jsonb, p_expected timestamptz)
returns timestamptz language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles; t public.tasks; v_now timestamptz := clock_timestamp();
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  select * into t from public.tasks where id = p_task->>'id' for update;
  if t.id is null or not public._can_see(v, t) then raise exception 'TASK_NOT_FOUND'; end if;
  if not public._can_edit(v, t) then raise exception 'NOT_ALLOWED'; end if;
  if p_expected is not null and t.updated_at is distinct from p_expected then raise exception 'TASK_CONFLICT'; end if;
  if (p_task->>'assignee_id') is distinct from t.assignee_id
     and not public._can_assign(v, p_task->>'assignee_id', coalesce(p_task->>'kind','task')) then
    raise exception 'NOT_ALLOWED';
  end if;
  update public.tasks set
    title = trim(p_task->>'title'), detail = coalesce(p_task->>'detail',''),
    assignee_id = p_task->>'assignee_id', assignee = public._assignee_name(p_task->>'assignee_id'),
    due = nullif(p_task->>'due','')::date, priority = coalesce(p_task->>'priority','normal'),
    project = nullif(trim(p_task->>'project'),''), kind = coalesce(p_task->>'kind','task'),
    meet_time = nullif(p_task->>'meet_time','')::time, meet_link = nullif(p_task->>'meet_link',''),
    updated_at = v_now
  where id = t.id;
  return v_now;
end;
$$;

-- Pano: durum değiştir (Yapılacak / Devam ediyor / Beklemede / Tamamlandı)
create or replace function public.set_task_status(p_session_token text, p_task_id text, p_status text)
returns timestamptz language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles; t public.tasks; v_now timestamptz := clock_timestamp();
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  if p_status not in ('todo','doing','waiting','done') then raise exception 'INVALID_TASK:status'; end if;
  select * into t from public.tasks where id = p_task_id for update;
  if t.id is null or not public._can_see(v, t) then raise exception 'TASK_NOT_FOUND'; end if;
  update public.tasks set
    status = p_status,
    done = (p_status = 'done'),
    completed_at = case when p_status = 'done' then coalesce(case when t.done then t.completed_at end, now()) else null end,
    completed_by = case when p_status = 'done' then coalesce(case when t.done then t.completed_by end, v.id) else null end,
    updated_at = v_now
  where id = t.id;
  return v_now;
end;
$$;

-- Eski onay kutusu çağrısı da durumu günceller
create or replace function public.update_task_state(p_session_token text, p_task_id text, p_done boolean, p_completed_at timestamptz)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public.set_task_status(p_session_token, p_task_id, case when p_done then 'done' else 'todo' end);
  return true;
exception when others then
  if sqlerrm = 'TASK_NOT_FOUND' then return false; end if;
  raise;
end;
$$;

create or replace function public.delete_task(p_session_token text, p_task_id text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles; t public.tasks;
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  select * into t from public.tasks where id = p_task_id;
  if t.id is null or not public._can_see(v, t) then return false; end if;
  if not (v.role = 'owner' or t.created_by = v.id) then raise exception 'NOT_ALLOWED'; end if;
  delete from public.tasks where id = t.id;
  return found;
end;
$$;

create or replace function public.restore_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v public.profiles; v_done boolean := coalesce((p_task->>'done')::boolean, false);
begin
  v := public._actor(p_session_token);
  if v.id is null then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  if not (v.role = 'owner' or p_task->>'created_by' = v.id) then raise exception 'NOT_ALLOWED'; end if;
  insert into public.tasks(id,title,detail,assignee,assignee_id,due,priority,status,project,done,created_at,completed_at,
                           created_by,completed_by,updated_at,kind,meet_time,meet_link)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''),
    public._assignee_name(p_task->>'assignee_id'), p_task->>'assignee_id',
    nullif(p_task->>'due','')::date, coalesce(p_task->>'priority','normal'),
    case when v_done then 'done' else coalesce(nullif(p_task->>'status','done'),'todo') end,
    nullif(trim(p_task->>'project'),''), v_done,
    least(coalesce(nullif(p_task->>'created_at','')::timestamptz, now()), now()),
    case when v_done then nullif(p_task->>'completed_at','')::timestamptz end,
    case when exists (select 1 from public.profiles where id = p_task->>'created_by') then p_task->>'created_by' end,
    case when v_done and exists (select 1 from public.profiles where id = p_task->>'completed_by') then p_task->>'completed_by' end,
    clock_timestamp(), coalesce(p_task->>'kind','task'), nullif(p_task->>'meet_time','')::time, nullif(p_task->>'meet_link','')
  )
  on conflict (id) do nothing;
  return found;
end;
$$;

-- Eski toplu yazma fonksiyonu artık kullanılmıyor; yetki kurallarını atlamasın diye kapatılır
revoke all on function public.upsert_task(text,jsonb) from public, anon, authenticated;

-- ---------- Notlar (kişi listesi artık profiles tablosundan) ----------
create or replace function public.save_profile_note(p_session_token text, p_profile_id text, p_body text)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if public._pin_session_profile(p_session_token) is distinct from p_profile_id then raise exception 'Access denied'; end if;
  if char_length(coalesce(p_body,'')) > 600 then raise exception 'Invalid note'; end if;
  insert into public.profile_notes(profile_id, body, updated_at) values (p_profile_id, coalesce(p_body,''), now())
  on conflict (profile_id) do update set body = excluded.body, updated_at = excluded.updated_at;
  return true;
end;
$$;

-- ---------- Yetkiler ----------
do $$
declare f text;
begin
  foreach f in array array[
    'list_login_profiles()', 'my_session(text)', 'list_team(text)', 'has_access_pin(text)',
    'setup_access_pin(text,text)', 'verify_access_pin(text,text)', 'change_access_pin(text,text)',
    'add_member(text,text,text,text)', 'update_member(text,text,boolean,text)',
    'list_tasks(text)', 'add_task(text,jsonb)', 'update_task(text,jsonb,timestamptz)',
    'set_task_status(text,text,text)', 'update_task_state(text,text,boolean,timestamptz)',
    'delete_task(text,text)', 'restore_task(text,jsonb)', 'save_profile_note(text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, authenticated', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
