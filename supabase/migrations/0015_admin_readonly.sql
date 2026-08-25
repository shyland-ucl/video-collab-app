-- Researcher admin role: read-only visibility across every trial project.
--
-- Participant isolation was already correct before this migration -- every
-- table is gated on is_project_member(), so a tester can only ever see the
-- projects they own or were invited to. What was missing is a way for the
-- researcher to observe the trial. This adds exactly that and nothing more:
-- SELECT policies gain "or is_app_admin()"; every INSERT/UPDATE/DELETE policy
-- is left untouched, so the admin physically cannot write to a participant's
-- project even if the UI were to try. Read-only is enforced by the database,
-- not by the client.

-- Admin identity lives in a table (not a hardcoded uuid) so a second
-- researcher can be added with one INSERT and no migration. RLS on with no
-- policies: invisible to anon and authenticated, exactly like allowed_emails.
create table public.admin_emails (
  email text primary key check (email = lower(email))
);
alter table public.admin_emails enable row level security;

insert into public.admin_emails (email) values ('l.xiao.22@ucl.ac.uk');

-- Keyed on the signed-in user's auth.users row rather than the JWT email
-- claim, so a stale token can never carry admin rights after the email is
-- removed from the table. auth.uid() is wrapped in a subselect so the planner
-- hoists it into an initplan (one evaluation per query, not per row) -- the
-- same trick 0007 applied to is_project_member.
create function public.is_app_admin()
returns boolean
language sql stable security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from auth.users u
    join public.admin_emails a on a.email = lower(u.email)
    where u.id = (select auth.uid())
  );
$fn$;

-- Executable by anon as well as authenticated, deliberately. This function is
-- called from INSIDE the RLS policies below, and a policy is evaluated for
-- whatever role made the request -- so if anon could not execute it, an
-- unauthenticated read of any of these tables would fail with "permission
-- denied for function" instead of simply matching no rows. It leaks nothing:
-- it answers only "is the caller an admin", and for anon auth.uid() is null so
-- the answer is always false. (is_project_member from 0001 is public for the
-- same reason.) The data-returning RPCs further down stay authenticated-only.
revoke execute on function public.is_app_admin() from public;
grant execute on function public.is_app_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- SELECT policies: add the admin. Write policies are deliberately unchanged.
-- ---------------------------------------------------------------------------

drop policy "members or owner read projects" on public.projects;
create policy "members or owner read projects" on public.projects
  for select using (
    owner_id = (select auth.uid())
    or public.is_project_member(id)
    or public.is_app_admin()
  );

drop policy "members read membership" on public.project_members;
create policy "members read membership" on public.project_members
  for select using (public.is_project_member(project_id) or public.is_app_admin());

drop policy "members read videos" on public.videos;
create policy "members read videos" on public.videos
  for select using (public.is_project_member(project_id) or public.is_app_admin());

drop policy "members read segments" on public.segments;
create policy "members read segments" on public.segments
  for select using (
    public.is_app_admin()
    or exists (
      select 1 from public.videos v
      where v.id = video_id and public.is_project_member(v.project_id)
    )
  );

drop policy "members read descriptions" on public.descriptions;
create policy "members read descriptions" on public.descriptions
  for select using (
    public.is_app_admin()
    or exists (
      select 1 from public.segments s
      join public.videos v on v.id = s.video_id
      where s.id = segment_id and public.is_project_member(v.project_id)
    )
  );

drop policy "members read project_state" on public.project_state;
create policy "members read project_state" on public.project_state
  for select using (public.is_project_member(project_id) or public.is_app_admin());

drop policy "members read tasks" on public.tasks;
create policy "members read tasks" on public.tasks
  for select using (public.is_project_member(project_id) or public.is_app_admin());

drop policy "members read suggestions" on public.suggestions;
create policy "members read suggestions" on public.suggestions
  for select using (public.is_project_member(project_id) or public.is_app_admin());

drop policy "members read renders" on public.renders;
create policy "members read renders" on public.renders
  for select using (public.is_project_member(project_id) or public.is_app_admin());

-- Video objects, segment clips, keyframes and rendered MP4s. Read only: the
-- insert/update policies from 0007 stay member-only, so the admin can watch a
-- participant's footage but can never overwrite or add to it.
drop policy "members read video objects" on storage.objects;
create policy "members read video objects" on storage.objects
  for select using (
    bucket_id = 'videos'
    and (
      public.is_app_admin()
      or public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
    )
  );

-- The interaction log was write-only for everyone (0014); researchers read it
-- out-of-band with scripts/export-events.mjs under the service role. Give the
-- admin an in-app SELECT so the dashboard can show activity counts and
-- last-seen times without a terminal. Still no participant read path.
create policy "admin reads events" on public.events
  for select using (public.is_app_admin());

-- ---------------------------------------------------------------------------
-- Admin-only RPCs. Participant emails live in auth.users, which no RLS policy
-- can expose -- these security-definer functions are the only way to surface
-- them, and each one gates on is_app_admin() before returning a single row.
-- ---------------------------------------------------------------------------

-- One row per project across the whole trial, with the roll-ups the dashboard
-- needs. Counts are computed in scalar subqueries rather than a chain of left
-- joins so no count is inflated by another table's fan-out.
create function public.admin_list_projects()
returns table (
  project_id uuid,
  title text,
  status text,
  created_at timestamptz,
  owner_id uuid,
  owner_email text,
  members jsonb,
  video_count integer,
  videos_ready integer,
  videos_processing integer,
  videos_failed integer,
  task_count integer,
  suggestion_count integer,
  render_count integer,
  state_version integer,
  event_count integer,
  last_activity_at timestamptz
)
language plpgsql stable security definer
set search_path = public
as $fn$
begin
  if not public.is_app_admin() then
    raise exception 'not_admin';
  end if;

  return query
  select
    p.id,
    p.title,
    p.status,
    p.created_at,
    p.owner_id,
    lower(owner.email)::text,
    coalesce(
      (select jsonb_agg(jsonb_build_object(
                'user_id', pm.user_id,
                'email', lower(mu.email),
                'role', pm.role)
              order by pm.role, mu.email)
         from project_members pm
         join auth.users mu on mu.id = pm.user_id
        where pm.project_id = p.id),
      '[]'::jsonb),
    (select count(*)::int from videos v where v.project_id = p.id),
    (select count(*)::int from videos v where v.project_id = p.id and v.status = 'ready'),
    (select count(*)::int from videos v where v.project_id = p.id and v.status = 'processing'),
    (select count(*)::int from videos v where v.project_id = p.id and v.status = 'failed'),
    (select count(*)::int from tasks t where t.project_id = p.id),
    (select count(*)::int from suggestions s where s.project_id = p.id),
    (select count(*)::int from renders r where r.project_id = p.id),
    coalesce((select max(ps.version) from project_state ps where ps.project_id = p.id), 0),
    (select count(*)::int from events e where e.project_id = p.id),
    -- greatest() skips NULLs, so a project with no videos/edits/events yet
    -- falls back to its own created_at
    greatest(
      p.created_at,
      (select max(v.created_at) from videos v where v.project_id = p.id),
      (select max(ps.created_at) from project_state ps where ps.project_id = p.id),
      (select max(t.updated_at) from tasks t where t.project_id = p.id),
      (select max(e.created_at) from events e where e.project_id = p.id)
    )
  from projects p
  join auth.users owner on owner.id = p.owner_id
  order by 17 desc nulls last;
end;
$fn$;

revoke execute on function public.admin_list_projects() from anon, public;
grant execute on function public.admin_list_projects() to authenticated;

-- Resolves the user ids the admin already sees (task authors, uploaders,
-- suggestion resolvers) to emails. Bounded so a caller can't page the whole
-- user table in one request.
create function public.admin_user_emails(p_user_ids uuid[])
returns table (user_id uuid, email text)
language plpgsql stable security definer
set search_path = public
as $fn$
begin
  if not public.is_app_admin() then
    raise exception 'not_admin';
  end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return;
  end if;
  if array_length(p_user_ids, 1) > 200 then
    raise exception 'too_many_ids';
  end if;

  return query
  select u.id, lower(u.email)::text
    from auth.users u
   where u.id = any (p_user_ids);
end;
$fn$;

revoke execute on function public.admin_user_emails(uuid[]) from anon, public;
grant execute on function public.admin_user_emails(uuid[]) to authenticated;

-- Per-project event roll-up for the inspector: what the pair actually did,
-- and when they last did it.
create function public.admin_project_events(p_project_id uuid)
returns table (event_type text, event_count integer, last_at timestamptz)
language plpgsql stable security definer
set search_path = public
as $fn$
begin
  if not public.is_app_admin() then
    raise exception 'not_admin';
  end if;

  return query
  select e.event_type, count(*)::int, max(e.created_at)
    from events e
   where e.project_id = p_project_id
   group by e.event_type
   order by max(e.created_at) desc;
end;
$fn$;

revoke execute on function public.admin_project_events(uuid) from anon, public;
grant execute on function public.admin_project_events(uuid) to authenticated;
