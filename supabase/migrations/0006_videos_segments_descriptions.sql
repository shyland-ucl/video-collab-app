-- Videos, segments, 3-level descriptions + RLS (Phase 1b)

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  uploaded_by uuid not null references auth.users (id) on delete cascade,
  original_name text not null check (char_length(original_name) between 1 and 300),
  storage_path text not null,
  status text not null default 'uploading'
    check (status in ('uploading', 'processing', 'ready', 'failed')),
  error text,
  duration_seconds numeric,
  width integer,
  height integer,
  fps numeric,
  size_bytes bigint,
  segment_length_seconds integer not null default 5
    check (segment_length_seconds between 2 and 60),
  created_at timestamptz not null default now()
);

create index videos_project_id_idx on public.videos (project_id);

create table public.segments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos (id) on delete cascade,
  idx integer not null check (idx >= 1),
  start_seconds numeric not null check (start_seconds >= 0),
  end_seconds numeric not null,
  label text not null,
  storage_path text not null,
  keyframe_path text not null,
  created_at timestamptz not null default now(),
  unique (video_id, idx),
  check (end_seconds > start_seconds)
);

create index segments_video_id_idx on public.segments (video_id);

create table public.descriptions (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.segments (id) on delete cascade,
  level integer not null check (level between 1 and 3),
  text text not null,
  source text not null default 'ai' check (source in ('ai', 'edited')),
  model text,
  generated_at timestamptz not null default now(),
  unique (segment_id, level)
);

create index descriptions_segment_id_idx on public.descriptions (segment_id);

alter table public.videos enable row level security;
alter table public.segments enable row level security;
alter table public.descriptions enable row level security;

create policy "members read videos" on public.videos
  for select using (public.is_project_member(project_id));

create policy "members add videos" on public.videos
  for insert with check (
    public.is_project_member(project_id) and uploaded_by = auth.uid()
  );

create policy "members read segments" on public.segments
  for select using (
    exists (
      select 1 from public.videos v
      where v.id = video_id and public.is_project_member(v.project_id)
    )
  );

create policy "members read descriptions" on public.descriptions
  for select using (
    exists (
      select 1 from public.segments s
      join public.videos v on v.id = s.video_id
      where s.id = segment_id and public.is_project_member(v.project_id)
    )
  );
