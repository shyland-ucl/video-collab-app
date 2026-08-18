-- Trial interaction log (design 2026-08-18): one row per participant action.
-- Two writers: the web client (participant's own events, RLS-checked) and the
-- server (service role, bypasses RLS) for events only it can see — processing
-- done, AI proposals, renders. Reading is researcher-only via the service
-- role (scripts/export-events.mjs): NO select/update/delete policies, so a
-- participant can never read another participant's log — or their own.
create table public.events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  project_id uuid references public.projects (id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 64),
  payload jsonb not null default '{}'::jsonb
);

create index events_project_created_idx on public.events (project_id, created_at);
create index events_user_created_idx on public.events (user_id, created_at);

alter table public.events enable row level security;

-- Insert-only, own user_id, and only into projects the participant belongs
-- to (project_id null is allowed for pre-membership events like sign_in).
create policy "participants insert own events" on public.events
  for insert with check (
    user_id = auth.uid()
    and (project_id is null or public.is_project_member(project_id))
  );

-- Deliberately NOT added to supabase_realtime: logs are written, never pushed.
