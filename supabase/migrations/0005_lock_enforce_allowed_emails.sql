-- enforce_allowed_emails is trigger-only; it must never be callable via the
-- Data API. Trigger execution is not gated by EXECUTE, so the trigger on
-- auth.users keeps firing.
revoke execute on function public.enforce_allowed_emails() from anon, authenticated, public;
