-- Phase 3b: persisted AI suggestions + their routing resolution.
-- Suggestions are NOT edit ops (not rebasable) so they live outside
-- project_state, in their own table, one row per curated suggestion. The
-- resolution (routed_to / outcome_status) is mutable columns on the same row.

create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  video_id uuid not null references public.videos (id) on delete cascade,
  model_suggestion_id text,
  category text not null check (category in ('issue', 'structural', 'creative')),
  text text not null check (char_length(text) between 1 and 500),
  related_scene integer not null,
  -- stable scene ref resolved server-side from related_scene at generation time,
  -- so a suggestion never points at the wrong scene after a split/delete/reorder
  segment_id uuid references public.segments (id) on delete set null,
  prototype_action text not null,
  fix_template jsonb,
  routed_to text check (routed_to in ('self', 'helper', 'ai')),
  outcome_status text check (outcome_status in ('pending', 'applied', 'failed')),
  task_id uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);

create index suggestions_project_video_idx on public.suggestions (project_id, video_id);

alter table public.suggestions enable row level security;

-- Members read + update (resolutions). NO member insert policy: only the
-- server (service-role key, bypasses RLS) writes suggestions on generation,
-- so a member can never forge a suggestion row.
create policy "members read suggestions" on public.suggestions
  for select using (public.is_project_member(project_id));

create policy "members update suggestions" on public.suggestions
  for update using (public.is_project_member(project_id));

-- postgres_changes for members (RLS applies to the change stream)
alter publication supabase_realtime add table public.suggestions;
