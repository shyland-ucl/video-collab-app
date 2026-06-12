-- 4-digit join codes replace token invite links (spec 2026-06-12-join-code-design.md)

-- The link flow is removed entirely
drop function if exists public.redeem_invite(uuid);
alter table public.invites drop column token;

alter table public.invites add column code text check (code ~ '^[0-9]{4}$');

-- create_invite sets expiry explicitly; the default just stops any future
-- insert path from silently inheriting the old 14-day window
alter table public.invites alter column expires_at set default now() + interval '15 minutes';

-- A code is unique among invites that have not been redeemed yet.
-- create_invite deletes expired unredeemed rows before generating, so the
-- active-code space stays small and collisions stay rare.
create unique index invites_active_code_idx on public.invites (code)
  where used_at is null;

-- Failed redemption attempts, for rate limiting (5 fails / 15 min per user).
create table public.code_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index code_attempts_user_idx on public.code_attempts (user_id, attempted_at);
-- RLS on with no policies: only the security definer functions touch this table.
alter table public.code_attempts enable row level security;

-- Tighten invites RLS: rows are created only via create_invite, so every code
-- is server-generated. Owner keeps read/delete.
drop policy "owner manages invites" on public.invites;
create policy "owner reads invites" on public.invites
  for select using (
    exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );
create policy "owner deletes invites" on public.invites
  for delete using (
    exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid())
  );

create function public.create_invite(p_project_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_code text;
  v_expires timestamptz;
  v_tries int := 0;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (
    select 1 from projects p where p.id = p_project_id and p.owner_id = auth.uid()
  ) then
    raise exception 'not_owner';
  end if;

  -- keep the active-code space small
  delete from invites where expires_at < now() and used_at is null;

  v_expires := now() + interval '15 minutes';
  loop
    v_code := lpad(floor(random() * 10000)::int::text, 4, '0');
    v_tries := v_tries + 1;
    begin
      insert into invites (project_id, created_by, role, code, expires_at)
      values (p_project_id, auth.uid(), 'helper', v_code, v_expires);
      exit;
    exception when unique_violation then
      if v_tries >= 20 then
        raise exception 'code_generation_failed';
      end if;
    end;
  end loop;

  return jsonb_build_object('code', v_code, 'expires_at', v_expires);
end;
$$;

revoke execute on function public.create_invite(uuid) from anon, public;
grant execute on function public.create_invite(uuid) to authenticated;

-- Returns a status object instead of raising: a raised exception would roll
-- back the failed-attempt row that the rate limit depends on.
create function public.redeem_code(p_code text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  inv invites%rowtype;
  recent_failures int;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  delete from code_attempts where attempted_at < now() - interval '15 minutes';
  select count(*) into recent_failures
    from code_attempts where user_id = auth.uid();
  if recent_failures >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;

  select * into inv from invites
    where code = p_code and used_at is null
    for update;
  if not found then
    insert into code_attempts (user_id) values (auth.uid());
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;
  if inv.expires_at < now() then
    insert into code_attempts (user_id) values (auth.uid());
    return jsonb_build_object('ok', false, 'reason', 'expired_code');
  end if;

  insert into project_members (project_id, user_id, role)
  values (inv.project_id, auth.uid(), inv.role)
  on conflict (project_id, user_id) do nothing;

  update invites set used_by = auth.uid(), used_at = now() where id = inv.id;

  return jsonb_build_object('ok', true, 'project_id', inv.project_id);
end;
$$;

revoke execute on function public.redeem_code(text) from anon, public;
grant execute on function public.redeem_code(text) to authenticated;
