-- Close the check-then-insert race in the render route (Phase 4): two concurrent
-- render requests could both pass the "is a render already in progress?" SELECT
-- and each insert a 'rendering' row, launching two encodes for one project.
--
-- A partial unique index lets at most one 'rendering' row exist per project, so
-- the loser's insert fails with a unique violation (SQLSTATE 23505); the route
-- maps that to the same 409 already_rendering the SELECT guard returns. Finished
-- renders ('ready'/'failed') are unconstrained, so history still accumulates.
create unique index renders_one_active_per_project
  on public.renders (project_id)
  where status = 'rendering';
