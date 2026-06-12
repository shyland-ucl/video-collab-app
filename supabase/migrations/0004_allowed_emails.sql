-- Allowlist gate for account creation (spec 2026-06-12-allowlist-password-auth-design.md)

create table public.allowed_emails (
  email text primary key check (email = lower(email))
);

-- RLS on with no policies: invisible to anon/authenticated. Only the service
-- role and the dashboard read or edit it; the app never queries it.
alter table public.allowed_emails enable row level security;

insert into public.allowed_emails (email) values
  ('l.xiao.22@ucl.ac.uk'),
  ('shylandforlizi@gmail.com');

-- Blocks every account-creation path (anon signup, admin API) because GoTrue
-- inserts into auth.users for all of them. GoTrue wraps the exception in a
-- generic "Database error saving new user" — the web app maps that to a
-- friendly message.
create function public.enforce_allowed_emails()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.email is null or not exists (
    select 1 from allowed_emails where email = lower(new.email)
  ) then
    raise exception 'email_not_allowed';
  end if;
  return new;
end;
$$;

create trigger before_user_created
  before insert on auth.users
  for each row execute function public.enforce_allowed_emails();
