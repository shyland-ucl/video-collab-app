-- Phase 1c: versioned shared edit state + durable helper tasks

create table public.project_state (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version integer not null check (version >= 1),
  state jsonb not null,
  updated_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);

create index project_state_latest_idx on public.project_state (project_id, version desc);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  segment_label text,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'needs_discussion', 'cant_do')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_project_id_idx on public.tasks (project_id);

alter table public.project_state enable row level security;
alter table public.tasks enable row level security;

create policy "members read project_state" on public.project_state
  for select using (public.is_project_member(project_id));

create policy "members append project_state" on public.project_state
  for insert with check (
    public.is_project_member(project_id) and updated_by = auth.uid()
  );

create policy "members read tasks" on public.tasks
  for select using (public.is_project_member(project_id));

create policy "members create tasks" on public.tasks
  for insert with check (
    public.is_project_member(project_id) and created_by = auth.uid()
  );

create policy "members update tasks" on public.tasks
  for update using (public.is_project_member(project_id));

create function public.touch_tasks_updated_at()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.touch_tasks_updated_at() from anon, authenticated, public;

create trigger on_task_updated
  before update on public.tasks
  for each row execute function public.touch_tasks_updated_at();

-- postgres_changes for members (RLS applies to the change stream)
alter publication supabase_realtime add table public.project_state;
alter publication supabase_realtime add table public.tasks;
