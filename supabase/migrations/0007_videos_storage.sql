-- Review fixes for 0006:
-- (a) lock videos.storage_path to the canonical object path so a client row
--     can never point the processing server at another project's object
alter table public.videos
  add constraint videos_storage_path_format
  check (storage_path = project_id::text || '/' || id::text || '/original.mp4');

-- (b) hoist auth.uid() into an initplan so RLS policies evaluate it once per
--     query instead of once per row (applies to all policies using this helper)
create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id and user_id = (select auth.uid())
  );
$$;

-- Private bucket for original videos, segment clips, and keyframes (Phase 1b).
-- Object names are '{project_id}/{video_id}/...' — the first path part gates access.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', false, 52428800, array['video/mp4', 'image/jpeg'])
on conflict (id) do nothing;

create policy "members read video objects" on storage.objects
  for select using (
    bucket_id = 'videos'
    and public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
  );

create policy "members insert video objects" on storage.objects
  for insert with check (
    bucket_id = 'videos'
    and public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
  );

-- TUS resumes/overwrites need update on the in-progress object row
create policy "members update video objects" on storage.objects
  for update using (
    bucket_id = 'videos'
    and public.is_project_member(((string_to_array(name, '/'))[1])::uuid)
  );
