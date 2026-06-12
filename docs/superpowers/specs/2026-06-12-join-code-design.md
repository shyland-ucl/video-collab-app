# Design: 4-digit join codes replace invite links

**Date:** 2026-06-12
**Status:** Approved by user
**Replaces:** the invite-link flow (`/join/:token`, `redeem_invite`, `inviteUrl`)

## Goal

Both users already have their own account (magic-link sign-in). A project already
acts as a "room" (`projects` + `project_members`). This change replaces *how a
collaborator gets into the room*: instead of the host sharing a long URL, the host
shows a short 4-digit code and the collaborator types it in on their own device.

## Decisions made during brainstorming

| Question | Decision |
| --- | --- |
| Code lifetime | Short-lived invite code: one person, one use, 15-minute expiry |
| Where the collaborator enters it | After sign-in, in a "Join with a code" box on their home (projects) page |
| Old link flow | Removed entirely; the code is the only way to join |
| Implementation approach | Extend the existing `invites` table and redemption logic (Option A) |
| 4-digit safety | Acceptable because codes are short-lived, single-use, and redemption is rate-limited (5 failed tries → 15-minute lockout per user) |

## User flow

1. Host opens their project, taps **"Invite a helper"**.
2. Screen shows a large, well-spaced 4-digit code (e.g. `4 8 2 7`) with
   "Expires in 15 minutes" and "Ask your helper to enter this code on their home page."
3. Collaborator signs in on their own device (existing magic-link flow, unchanged).
4. On their projects page, the collaborator types the code into the
   **"Join with a code"** box and taps Join.
5. They are added to the project as a `helper` and navigated straight into it.
6. Tapping "Invite a helper" again at any time generates a fresh code.

## Database changes (one new migration, `0003_join_codes.sql`)

### `invites` table

- Add `code text` column (4 digits, zero-padded).
- Partial unique index on `code` where `used_at is null` — a code is unique among
  codes that have not been redeemed. Expired unredeemed rows are deleted by
  `create_invite` before generating, so they cannot block reuse for long.
- Drop the `token` column (link flow removed).
- New rows get `expires_at = now() + interval '15 minutes'` (set by `create_invite`;
  the old 14-day column default is replaced).

### New function `create_invite(p_project_id uuid)`

`security definer`. Behavior:

1. Reject unauthenticated callers and callers who are not the project owner.
2. Delete invites where `expires_at < now() and used_at is null` (cleanup keeps the
   active-code space small, so collisions among 10,000 possible codes stay rare).
3. Generate a random 4-digit code (`0000`–`9999`); retry on collision with an
   active code (bounded retries, then raise).
4. Insert the invite row (`role = 'helper'`, 15-minute expiry) and return
   `(code, expires_at)`.

Grant execute to `authenticated` only.

### New function `redeem_code(p_code text)`

`security definer`, modeled on the existing `redeem_invite`:

1. Reject unauthenticated callers (`not_authenticated`).
2. Rate limit: if the caller has 5 or more failed attempts in the last 15 minutes,
   raise `too_many_attempts`.
3. Look up the invite by `code` where `used_at is null`, locking the row.
   Not found → record a failed attempt, raise `invalid_code`. (An already-used
   code behaves like an invalid one; the collaborator who used it is already a
   member and sees the project in their list.)
4. Expired → record a failed attempt, raise `expired_code`.
5. Insert into `project_members (project_id, user_id, 'helper')`
   `on conflict do nothing` — safe when the user is already a member, e.g. they
   redeem a fresh code for a project they previously joined.
6. Mark the invite `used_by = auth.uid(), used_at = now()`.
7. Return the `project_id`.

Grant execute to `authenticated` only; revoke from `anon`/`public`.

### New table `code_attempts`

- Columns: `user_id uuid`, `attempted_at timestamptz default now()`.
- A row is inserted on each *failed* redemption; `redeem_code` counts recent rows
  for the caller to enforce the lockout, and opportunistically deletes rows older
  than 15 minutes.
- RLS enabled with no policies (only the `security definer` function touches it).

### Tightened RLS on `invites`

Replace the current "owner manages invites" `for all` policy with owner-scoped
`select` and `delete` policies only. Rows are created exclusively through
`create_invite`, so every code is server-generated — an owner can no longer
insert a hand-picked code by writing to the table directly.

### Removals

- Drop function `redeem_invite(uuid)`.
- Drop `invites.token`.

## Web app changes

### `ProjectPage.jsx` (host side)

- "Invite a helper" now calls `supabase.rpc('create_invite', …)` and renders the
  returned code in large, letter-spaced digits, with the expiry note and helper
  instruction.
- Remove `navigator.share` / clipboard logic and the `inviteUrl` import.
- Keep the double-tap guard and screen-reader announcement
  ("Invite code created: 4 8 2 7").
- Pressing the button again replaces the shown code with a fresh one.

### `ProjectsPage.jsx` (collaborator side)

- New "Join with a code" section above the project list: a labeled 4-digit input
  (`inputmode="numeric"`, `autocomplete="one-time-code"`) and a Join button.
- On success: announce "Joined project", navigate to `/projects/<id>`.
- On failure: inline error message (see below) plus assertive announcement.
- Submit is disabled while a redemption is in flight.

### Removals

- `JoinPage.jsx` + its tests, the `/join/:token` route in `App.jsx`,
  `lib/inviteUrl.js` + its tests.

## Error messages (collaborator side)

| Backend error | Message shown |
| --- | --- |
| `invalid_code` | "That code didn't work. Check the digits and try again." |
| `expired_code` | "This code has expired. Ask for a new one." |
| `too_many_attempts` | "Too many tries. Please wait 15 minutes." |
| anything else | "Could not join the project. Please try again." |

Host-side `create_invite` failure: "Could not create a code. Only the project
owner can invite." (mirrors today's message).

## Testing

- **ProjectPage tests:** invite button renders a 4-digit code and expiry note;
  error path when a non-owner tries; announcement made; second press replaces code.
- **ProjectsPage tests:** join box happy path navigates to the project; each error
  message renders for its backend error; button disabled while pending.
- **Backend E2E smoke script** (`scripts/`): extend to create a project as user A,
  `create_invite`, then `redeem_code` as user B, and assert membership; verify a
  wrong code fails and the same code cannot be redeemed by a third user.
- Removed tests: `JoinPage.test.jsx`, `inviteUrl.test.js`.

## Out of scope

- Changing the sign-in experience itself (magic-link email stays as is).
- Roles beyond `helper` for code joins.
- Multi-use or long-lived room codes.
