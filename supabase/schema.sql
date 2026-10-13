-- Unipakt shared tasks and private per-profile sticky notes.
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
grant select, insert, update, delete on public.tasks to anon;
drop policy if exists "team can manage tasks" on public.tasks;
create policy "team can manage tasks" on public.tasks for all to anon using (true) with check (true);

create table if not exists public.profile_notes (
  profile_id text primary key check (profile_id in ('akif','mehmet','ugur')),
  body text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profile_notes enable row level security;
grant select, insert, update, delete on public.profile_notes to anon;
drop policy if exists "team can manage profile notes" on public.profile_notes;
create policy "team can manage profile notes" on public.profile_notes for all to anon using (true) with check (true);

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.profile_notes;
