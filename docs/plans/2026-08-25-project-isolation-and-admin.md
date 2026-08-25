# Project isolation + researcher admin (2026-08-25)

Written for the field trial: testers must only ever see their own project, and
the researcher must be able to see all of them without being able to disturb
any.

## What was already true

Participant isolation did **not** need building. Every table has had RLS since
Phase 1:

| Table / bucket | SELECT gate (before this change) |
| --- | --- |
| `projects` | owner, or `is_project_member(id)` |
| `project_members`, `videos`, `project_state`, `tasks`, `suggestions`, `renders` | `is_project_member(project_id)` |
| `segments`, `descriptions` | membership of the owning video's project |
| `storage.objects` (`videos` bucket) | `is_project_member()` on the first path part |
| `events` | nobody — insert-only for participants (0014) |

The server holds the service-role key (which bypasses RLS), so every mutating
route re-checks `project_members` by hand before doing anything —
`loadVideoForMember` in `routes/videos.js` and the equivalent guard at the top
of `aiEdit.js`, `suggest.js` and `render.js`.

`ProjectsPage` *looked* like it selected every project (`select(...).order(...)`
with no filter), but RLS was silently narrowing the result to the caller's own.
That worked, and still would — but see the one behaviour change below.

## What this change adds

**Migration `0015_admin_readonly.sql`.**

- `public.admin_emails` — a table, not a hardcoded uuid, so a second researcher
  is one INSERT away. RLS on with no policies (invisible to the app, same
  pattern as `allowed_emails`). Seeded with `l.xiao.22@ucl.ac.uk`.
- `public.is_app_admin()` — security definer, joins `auth.users` on
  `auth.uid()` against that table. Keyed on the *account*, not the JWT email
  claim, so revoking admin takes effect on the next request rather than on the
  next token refresh. Executable by `anon` too, because it is called from
  inside RLS policies and those are evaluated as whatever role made the
  request; it answers only "is the caller an admin", so this leaks nothing.
- `or public.is_app_admin()` added to the SELECT policy of every table in the
  matrix above, plus a new SELECT policy on `events`.
- **Every INSERT / UPDATE / DELETE policy is untouched.** Read-only is a
  property of the database, not of the UI. The admin has no write path to
  refuse, so there is nothing to get wrong in the client.
- Three admin-only RPCs, each re-checking `is_app_admin()` server-side:
  `admin_list_projects()` (the dashboard roll-up, ordered by last activity),
  `admin_user_emails(uuid[])` (participant emails — `auth.users` is reachable
  no other way; capped at 200 ids), and `admin_project_events(uuid)`.

**Web.**

- `lib/admin.js` — the RPC wrappers plus the pure helpers (`projectStage`,
  `timeAgo`, `orderMembers`, formatters). `fetchIsAdmin` resolves to `false` on
  any failure, so a participant never sees an admin affordance because of an
  error.
- `AuthContext` gains `isAdmin` (`undefined` while unresolved). It is a UI
  convenience only — forcing it true in a console still shows nothing.
- `/admin` — the trial dashboard. Per project: stage pill, both participants'
  emails and roles, video/timeline/task/suggestion/export counts, last activity,
  logged-action count. Filter box over project name and participant email.
- `/admin/projects/:id` — a read-only inspector: people, videos (with the
  failure message when processing died), the saved timeline rendered as a scene
  table with trims applied, helper tasks, AI suggestions and how they were
  routed, exports with a download link for the newest ready one, and the
  interaction-log roll-up.
- Both routes are `lazy()` so no participant ever downloads them, and sit
  behind `RequireAdmin`.

### Why a separate inspector rather than opening the editor read-only

`EditorPage` is 740 lines built to mutate. Threading a `readOnly` flag through
it would leave the researcher one missed code path from writing into trial
data, and would put that risk in the file the trial depends on most. The
inspector is additive: it only ever SELECTs, and it shows things the editor
does not (the interaction log, failure messages, how each suggestion was
routed). The editor already refuses the admin for free — its first query is
"what is my role in this project?", which returns nothing for a non-member — so
the only change there is to point that message at the inspector.

`ProjectPage` redirects an admin non-member to the inspector for the same
reason: otherwise it would offer upload / invite / open-editor controls that the
database will refuse.

### The one behaviour change for participants

`ProjectsPage` now scopes "Your projects" explicitly — it reads the caller's own
`project_members` rows and filters on `owner_id.eq.<me>,id.in.(...)` — instead
of relying on RLS to narrow it. For a participant the result is identical. For
the admin it is the difference between "your projects" and "the whole trial",
which belongs on `/admin`.

## Operating it

```
node --env-file=server/.env scripts/admin-emails.mjs list
node --env-file=server/.env scripts/admin-emails.mjs add    someone@example.com
node --env-file=server/.env scripts/admin-emails.mjs remove someone@example.com
```

Adding an email does not create an account and does not touch the sign-up
allowlist — those are separate gates. An admin row with no matching account is
inert (`is_app_admin()` joins `auth.users` and finds nothing); the script says
so when that is the case.

## Deploying

1. `supabase db push` — applies 0015 to the live database.
2. Push to `main`; Vercel builds the web app.
3. Sign in as `l.xiao.22@ucl.ac.uk` — "Trial dashboard" appears next to
   Settings on the projects page.
4. Sanity check with a participant account: they see only their own project,
   and `/admin` refuses them.
