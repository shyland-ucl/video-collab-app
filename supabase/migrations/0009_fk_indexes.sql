-- 0008 review fix: index FK columns so auth.users cascades never seq-scan
create index if not exists project_state_updated_by_idx on public.project_state (updated_by);
create index if not exists tasks_created_by_idx on public.tasks (created_by);
