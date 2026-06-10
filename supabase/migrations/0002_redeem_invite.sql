create function public.redeem_invite(invite_token uuid)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  inv invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select * into inv from invites where token = invite_token for update;
  if not found then
    raise exception 'invalid_invite';
  end if;
  if inv.expires_at < now() then
    raise exception 'expired_invite';
  end if;
  if inv.used_by is not null and inv.used_by <> auth.uid() then
    raise exception 'used_invite';
  end if;

  insert into project_members (project_id, user_id, role)
  values (inv.project_id, auth.uid(), inv.role)
  on conflict (project_id, user_id) do nothing;

  update invites set used_by = auth.uid(), used_at = now()
  where id = inv.id and used_by is null;

  return inv.project_id;
end;
$$;

revoke execute on function public.redeem_invite(uuid) from anon, public;
grant execute on function public.redeem_invite(uuid) to authenticated;
