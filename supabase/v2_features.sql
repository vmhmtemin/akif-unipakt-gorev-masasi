-- =============================================================================
-- Unipakt Görev Masası — v2 özellikleri (2026-10)
--
-- security_hardening.sql'den SONRA, Supabase SQL Editor'da BİR KEZ çalıştırın.
-- Tekrar çalıştırmak zararsızdır; mevcut görevler korunur.
--
-- Eklenenler:
--   * tasks.priority      'normal' | 'urgent'
--   * tasks.created_by    görevi ekleyen profil (oturumdan otomatik)
--   * tasks.completed_by  görevi tamamlayan profil (oturumdan otomatik)
--   * tasks.updated_at    eşzamanlı düzenleme kontrolü için
--   * update_task  : görevi düzenler; arada başkası değiştirdiyse TASK_CONFLICT
--   * restore_task : silinen görevi "Geri al" ile aynen geri koyar
--   * tasks.kind 'task' | 'meet', meet_time (saat), meet_link (https bağlantısı)
-- =============================================================================

alter table public.tasks add column if not exists priority     text not null default 'normal';
alter table public.tasks add column if not exists created_by   text;
alter table public.tasks add column if not exists completed_by text;
alter table public.tasks add column if not exists updated_at   timestamptz not null default now();
alter table public.tasks add column if not exists kind         text not null default 'task';
alter table public.tasks add column if not exists meet_time    time;
alter table public.tasks add column if not exists meet_link    text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_priority_check') then
    alter table public.tasks add constraint tasks_priority_check check (priority in ('normal','urgent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_kind_check') then
    alter table public.tasks add constraint tasks_kind_check check (kind in ('task','meet'));
  end if;
end $$;

-- ---------- Doğrulama (öncelik dahil) ----------
create or replace function public._validate_task(p_task jsonb)
returns void language plpgsql immutable
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_task->>'id','') !~ '^[A-Za-z0-9._:-]{1,64}$' then raise exception 'INVALID_TASK:id'; end if;
  if char_length(trim(coalesce(p_task->>'title',''))) not between 1 and 120 then raise exception 'INVALID_TASK:title'; end if;
  if char_length(coalesce(p_task->>'detail','')) > 400 then raise exception 'INVALID_TASK:detail'; end if;
  if char_length(trim(coalesce(p_task->>'assignee',''))) not between 1 and 60 then raise exception 'INVALID_TASK:assignee'; end if;
  if coalesce(p_task->>'priority','normal') not in ('normal','urgent') then raise exception 'INVALID_TASK:priority'; end if;
  if nullif(p_task->>'due','') is not null and (p_task->>'due') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_TASK:due'; end if;
  if coalesce(p_task->>'kind','task') not in ('task','meet') then raise exception 'INVALID_TASK:kind'; end if;
  if coalesce(p_task->>'kind','task') = 'meet' then
    -- Meet: tarih ve saat zorunlu; bağlantı yalnızca https olabilir
    if nullif(p_task->>'due','') is null then raise exception 'INVALID_TASK:meet_date'; end if;
    if coalesce(p_task->>'meet_time','') !~ '^([01]\d|2[0-3]):[0-5]\d(:00)?$' then raise exception 'INVALID_TASK:meet_time'; end if;
  end if;
  if nullif(p_task->>'meet_link','') is not null and ((p_task->>'meet_link') !~ '^https://[^\s"''<>]+$' or char_length(p_task->>'meet_link') > 300) then raise exception 'INVALID_TASK:meet_link'; end if;
end;
$$;
revoke all on function public._validate_task(jsonb) from public, anon, authenticated;

-- list_tasks yeni sütunları da döndürsün diye yeniden oluşturulur
create or replace function public.list_tasks(p_session_token text)
returns setof public.tasks language plpgsql stable security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  return query select * from public.tasks order by created_at desc;
end;
$$;

-- ---------- Ekleme ----------
create or replace function public.add_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_profile text := public._pin_session_profile(p_session_token);
begin
  if v_profile is null then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  insert into public.tasks(id,title,detail,assignee,due,priority,done,created_at,completed_at,created_by,updated_at,kind,meet_time,meet_link)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''), trim(p_task->>'assignee'),
    nullif(p_task->>'due','')::date, coalesce(p_task->>'priority','normal'), false, now(), null, v_profile, now(),
    coalesce(p_task->>'kind','task'), nullif(p_task->>'meet_time','')::time, nullif(p_task->>'meet_link','')
  )
  on conflict (id) do nothing;
  return found;
end;
$$;

-- ---------- Düzenleme ----------
-- p_expected: istemcinin gördüğü updated_at. Farklıysa biri arada değiştirmiştir.
create or replace function public.update_task(p_session_token text, p_task jsonb, p_expected timestamptz)
returns timestamptz language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_current timestamptz; v_now timestamptz := clock_timestamp();
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  select updated_at into v_current from public.tasks where id = p_task->>'id' for update;
  if not found then raise exception 'TASK_NOT_FOUND'; end if;
  if p_expected is not null and v_current is distinct from p_expected then raise exception 'TASK_CONFLICT'; end if;
  update public.tasks set
    title = trim(p_task->>'title'), detail = coalesce(p_task->>'detail',''), assignee = trim(p_task->>'assignee'),
    due = nullif(p_task->>'due','')::date, priority = coalesce(p_task->>'priority','normal'), updated_at = v_now,
    kind = coalesce(p_task->>'kind','task'), meet_time = nullif(p_task->>'meet_time','')::time, meet_link = nullif(p_task->>'meet_link','')
  where id = p_task->>'id';
  return v_now;
end;
$$;

-- ---------- Tamamla / geri al (tamamlayanı kaydeder) ----------
create or replace function public.update_task_state(p_session_token text, p_task_id text, p_done boolean, p_completed_at timestamptz)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare v_profile text := public._pin_session_profile(p_session_token);
begin
  if v_profile is null then raise exception 'Access denied'; end if;
  update public.tasks set
    done = p_done,
    completed_at = case when p_done then coalesce(p_completed_at, now()) else null end,
    completed_by = case when p_done then v_profile else null end,
    updated_at = clock_timestamp()
  where id = p_task_id;
  return found;
end;
$$;

-- ---------- Silmeyi geri alma ----------
create or replace function public.restore_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  insert into public.tasks(id,title,detail,assignee,due,priority,done,created_at,completed_at,created_by,completed_by,updated_at,kind,meet_time,meet_link)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''), trim(p_task->>'assignee'),
    nullif(p_task->>'due','')::date, coalesce(p_task->>'priority','normal'),
    coalesce((p_task->>'done')::boolean, false),
    least(coalesce(nullif(p_task->>'created_at','')::timestamptz, now()), now()),
    case when coalesce((p_task->>'done')::boolean, false) then nullif(p_task->>'completed_at','')::timestamptz end,
    case when p_task->>'created_by' in ('akif','mehmet','ugur') then p_task->>'created_by' end,
    case when coalesce((p_task->>'done')::boolean, false) and p_task->>'completed_by' in ('akif','mehmet','ugur') then p_task->>'completed_by' end,
    clock_timestamp(),
    coalesce(p_task->>'kind','task'), nullif(p_task->>'meet_time','')::time, nullif(p_task->>'meet_link','')
  )
  on conflict (id) do nothing;
  return found;
end;
$$;

-- ---------- Yetkiler ----------
revoke all on function public.list_tasks(text) from public, authenticated;
revoke all on function public.add_task(text,jsonb) from public, authenticated;
revoke all on function public.update_task(text,jsonb,timestamptz) from public, authenticated;
revoke all on function public.update_task_state(text,text,boolean,timestamptz) from public, authenticated;
revoke all on function public.restore_task(text,jsonb) from public, authenticated;
grant execute on function public.list_tasks(text) to anon;
grant execute on function public.add_task(text,jsonb) to anon;
grant execute on function public.update_task(text,jsonb,timestamptz) to anon;
grant execute on function public.update_task_state(text,text,boolean,timestamptz) to anon;
grant execute on function public.restore_task(text,jsonb) to anon;

notify pgrst, 'reload schema';
