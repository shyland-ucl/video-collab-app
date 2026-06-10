-- Projects, membership, invites + RLS
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('creator', 'helper')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  role text not null default 'helper' check (role in ('creator', 'helper')),
  created_by uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '14 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index projects_owner_id_idx on public.projects (owner_id);
create index project_members_user_id_idx on public.project_members (user_id);
create index invites_project_id_idx on public.invites (project_id);

-- security definer so policies on project_members can call it without recursing
create function public.is_project_member(p_project_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from project_members
    where project_id = p_project_id and user_id = auth.uid()
  );
$$;

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.invites enable row level security;

create policy "members or owner read projects" on public.projects
  for select using (owner_id = auth.uid() or public.is_project_member(id));
create policy "owner inserts own project" on public.projects
  for insert with check (owner_id = auth.uid());
create policy "owner updates project" on public.projects
  for update using (owner_id = auth.uid());
create policy "owner deletes project" on public.projects
  for delete using (owner_id = auth.uid());

create policy "members read membership" on public.project_members
  for select using (public.is_project_member(project_id));

create policy "owner manages invites" on public.invites
  for all
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

-- owner automatically becomes a creator-member
create function public.handle_new_project()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'creator');
  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();
