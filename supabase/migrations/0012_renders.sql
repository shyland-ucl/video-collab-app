-- Phase 4: project-level render jobs (EDL → MP4). Server-written (service-role);
-- members read. Mirrors the suggestions/tasks RLS pattern. A render is keyed by
-- project (the EDL can span multiple source videos), not a single videos row.
create table public.renders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  status text not null default 'rendering'
    check (status in ('rendering', 'ready', 'failed')),
  output_path text,
  error text,
  edl_version integer,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index renders_project_created_idx on public.renders (project_id, created_at desc);

alter table public.renders enable row level security;

-- Members read; only the server (service-role bypasses RLS) inserts/updates.
create policy "members read renders" on public.renders
  for select using (public.is_project_member(project_id));

alter publication supabase_realtime add table public.renders;

-- Rendered videos are larger than the 50MB segment limit — raise it to 500MB.
update storage.buckets set file_size_limit = 524288000 where id = 'videos';
