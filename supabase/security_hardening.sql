-- =============================================================================
-- Unipakt Görev Masası — güvenlik sıkılaştırması (2026-10)
--
-- Mevcut kurulumun üzerine Supabase SQL Editor'da BİR KEZ çalıştırın.
-- Tekrar çalıştırmak zararsızdır. Mevcut görevler, notlar ve kodlar korunur.
--
-- 1. Kod denemesi sınırı: bir profil için 5 hatalı denemeden sonra o profil
--    15 dakika kilitlenir; kilit her yeni 5 hatada 2 katına çıkar (en fazla
--    24 saat). Başarılı giriş sayacı sıfırlar. 4 haneli kod artık deneme
--    yanılmayla kırılamaz.
-- 2. Görev doğrulaması: kimlik yalnızca harf/rakam/. _ : - (en fazla 64), başlık
--    1–120, detay en fazla 400, sorumlu 1–60 karakter. Sayfaya zararlı kod
--    sokulamaz, veritabanı şişirilemez.
-- 3. add_task: yeni görev ekler, var olan bir görevin üzerine ASLA yazmaz.
--    (Eski upsert_task, eşzamanlı değişiklikleri ezebiliyordu; istemci artık
--    onu kullanmıyor.)
-- =============================================================================

-- ---------- 1. Kod denemesi sınırı ----------
create table if not exists public.pin_attempts (
  profile_id   text primary key check (profile_id in ('akif','mehmet','ugur')),
  failed       integer not null default 0,
  locked_until timestamptz
);
alter table public.pin_attempts enable row level security;
revoke all on public.pin_attempts from public, anon, authenticated;

create or replace function public.verify_access_pin(p_profile_id text, p_pin text)
returns text language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_hash text;
  v_token text;
  v_att public.pin_attempts%rowtype;
  v_lock_minutes integer;
begin
  if p_profile_id not in ('akif','mehmet','ugur') then return null; end if;

  -- Satırı kilitle: aynı anda gelen paralel denemeler sayacı atlatamasın
  insert into public.pin_attempts(profile_id) values (p_profile_id) on conflict (profile_id) do nothing;
  select * into v_att from public.pin_attempts where profile_id = p_profile_id for update;

  if v_att.locked_until is not null and v_att.locked_until > now() then
    raise exception 'PIN_LOCKED:%', ceil(extract(epoch from (v_att.locked_until - now())) / 60)::int;
  end if;

  if p_pin is null or p_pin !~ '^[0-9]{4}$' then return null; end if;

  select pin_hash into v_hash from public.profile_access_pins where profile_id = p_profile_id;
  if v_hash is null or crypt(p_pin, v_hash) <> v_hash then
    v_att.failed := v_att.failed + 1;
    if v_att.failed % 5 = 0 then
      -- 5 hatada 15 dk, 10 hatada 30 dk, 15'te 60 dk ... en fazla 24 saat
      v_lock_minutes := least(15 * power(2, v_att.failed / 5 - 1)::int, 1440);
      update public.pin_attempts
        set failed = v_att.failed, locked_until = now() + make_interval(mins => v_lock_minutes)
        where profile_id = p_profile_id;
    else
      update public.pin_attempts set failed = v_att.failed where profile_id = p_profile_id;
    end if;
    return null;
  end if;

  update public.pin_attempts set failed = 0, locked_until = null where profile_id = p_profile_id;

  v_token := encode(gen_random_bytes(32), 'hex');
  delete from public.app_access_sessions where expires_at <= now();
  insert into public.app_access_sessions(token_hash, expires_at, profile_id)
  values (encode(digest(v_token, 'sha256'), 'hex'), now() + interval '12 hours', p_profile_id);
  return v_token;
end;
$$;

-- ---------- 2. Görev doğrulaması ----------
-- Tabloya doğrudan yazma anonim kullanıcıya kapalı; her yazma aşağıdaki
-- fonksiyonlardan geçtiği için kurallar orada uygulanır. (Tabloya CHECK
-- eklenmez: eski satırların durum güncellemesini engelleyebilirdi.)
-- Önceki bir sürümde eklendiyse kaldır:
alter table public.tasks drop constraint if exists tasks_id_format;
alter table public.tasks drop constraint if exists tasks_detail_length;
alter table public.tasks drop constraint if exists tasks_assignee_length;

-- Ortak doğrulama: hatalıysa anlaşılır bir hata verir
create or replace function public._validate_task(p_task jsonb)
returns void language plpgsql immutable
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_task->>'id','') !~ '^[A-Za-z0-9._:-]{1,64}$' then raise exception 'INVALID_TASK:id'; end if;
  if char_length(trim(coalesce(p_task->>'title',''))) not between 1 and 120 then raise exception 'INVALID_TASK:title'; end if;
  if char_length(coalesce(p_task->>'detail','')) > 400 then raise exception 'INVALID_TASK:detail'; end if;
  if char_length(trim(coalesce(p_task->>'assignee',''))) not between 1 and 60 then raise exception 'INVALID_TASK:assignee'; end if;
end;
$$;
revoke all on function public._validate_task(jsonb) from public, anon, authenticated;

-- Eski fonksiyon (geri uyumluluk için duruyor) de artık doğruluyor
create or replace function public.upsert_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  insert into public.tasks(id,title,detail,assignee,due,done,created_at,completed_at)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''), trim(p_task->>'assignee'),
    nullif(p_task->>'due','')::date, coalesce((p_task->>'done')::boolean,false),
    coalesce(nullif(p_task->>'created_at','')::timestamptz,now()), nullif(p_task->>'completed_at','')::timestamptz
  )
  on conflict (id) do update set title=excluded.title, detail=excluded.detail, assignee=excluded.assignee,
    due=excluded.due, done=excluded.done, created_at=excluded.created_at, completed_at=excluded.completed_at;
  return true;
end;
$$;

-- ---------- 3. Yalnızca ekleyen fonksiyon ----------
create or replace function public.add_task(p_session_token text, p_task jsonb)
returns boolean language plpgsql security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if not public._has_valid_pin_session(p_session_token) then raise exception 'Access denied'; end if;
  perform public._validate_task(p_task);
  insert into public.tasks(id,title,detail,assignee,due,done,created_at,completed_at)
  values (
    p_task->>'id', trim(p_task->>'title'), coalesce(p_task->>'detail',''), trim(p_task->>'assignee'),
    nullif(p_task->>'due','')::date, false, now(), null
  )
  on conflict (id) do nothing;
  return found;
end;
$$;

-- ---------- Yetkiler ----------
revoke all on function public.verify_access_pin(text,text) from public, authenticated;
revoke all on function public.upsert_task(text,jsonb) from public, authenticated;
revoke all on function public.add_task(text,jsonb) from public, authenticated;
grant execute on function public.verify_access_pin(text,text) to anon;
grant execute on function public.upsert_task(text,jsonb) to anon;
grant execute on function public.add_task(text,jsonb) to anon;

-- Supabase API'nin yeni fonksiyonu hemen görmesi için
notify pgrst, 'reload schema';
