-- Phase 3b review fix: scope the members-UPDATE on suggestions to the RESOLUTION
-- columns only. The prior policy (0010) granted UPDATE on every column, so a
-- member could rewrite the AI-authored `text` or re-point the server-resolved
-- `segment_id` (the stable scene anchor). Only the resolution columns are ever
-- written by a member (setSuggestionResolution / updateSuggestionOutcome); the
-- rest are server-authored and must be immutable to clients.

-- Replace the table-wide UPDATE grant with a column-scoped one. Service-role
-- (the generator) bypasses RLS + grants, so it can still write every column.
revoke update on public.suggestions from authenticated;
grant update (routed_to, outcome_status, task_id, resolved_at, resolved_by)
  on public.suggestions to authenticated;

-- Add an explicit WITH CHECK so the intent is documented and a future column
-- can't silently widen the surface (USING alone is reused for the NEW row,
-- which already blocks moving a row into a non-member project).
drop policy "members update suggestions" on public.suggestions;
create policy "members update suggestions" on public.suggestions
  for update using (public.is_project_member(project_id))
  with check (public.is_project_member(project_id));
