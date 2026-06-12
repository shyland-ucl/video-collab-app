# Design: Allowlist + password sign-in replaces magic links

**Date:** 2026-06-12
**Status:** Approved by user
**Replaces:** magic-link email sign-in (UI only; SMTP config stays in place, unused)

## Goal

Magic-link sign-in depends on email delivery, which has proven unreliable
(slow arrival, spam filtering, send limits). Replace it with: a fixed list of
allowed emails; anyone on the list signs in with email + password. First-time
users on the list create their password in the app instantly — no email is
ever sent (the project already has `enable_confirmations = false`).

## Decisions made during brainstorming

| Question | Decision |
| --- | --- |
| Login method | Email + password |
| First-time password | User picks it themselves via "First time here? Create your password" (signup gated by allowlist) |
| Allowlist management | `allowed_emails` table edited in the Supabase dashboard table editor |
| Initial list | `l.xiao.22@ucl.ac.uk`, `shylandforlizi@gmail.com` |
| Enforcement | Database trigger on `auth.users` insert (server-side, unbypassable) |
| Existing accounts | One-time admin step sets starting passwords for the two existing users (they cannot re-sign-up) |
| Magic link | Removed from the UI; Supabase SMTP/auth config left as is |

## User flow

1. Visitor opens the app → sign-in page shows **Email** and **Password** fields
   with a **Sign in** button, and below it a toggle:
   **"First time here? Create your password"**.
2. Returning user: email + password → signed in → projects page (the `next`
   redirect behavior via `safeNext` is preserved).
3. First-time allowed user: switches to create mode, enters email + chosen
   password (min 6 chars per project config) → account created and signed in
   immediately, no email round-trip.
4. Person not on the list tries to create a password → friendly rejection;
   no account is created (enforced by the database, not the client).

## Database changes (one new migration, `0004_allowed_emails.sql`)

### `allowed_emails` table

- `email text primary key`, with a `check (email = lower(email))` constraint
  (comparisons happen on lowercased input).
- RLS enabled with **no policies**: the table is invisible to app users
  (anon and authenticated); only the service role / dashboard can read or
  edit it. The app never queries it.
- Seeded with the two initial emails.

### Signup guard trigger

- `before insert on auth.users` trigger function (security definer,
  `set search_path = public`): if `lower(new.email)` is not in
  `allowed_emails`, raise `email_not_allowed`.
- This blocks every account-creation path (anon signup, API calls), because
  GoTrue inserts into `auth.users` for all of them.
- Known caveat: GoTrue wraps trigger exceptions in a generic
  "Database error saving new user" (HTTP 500) — the web app maps that to the
  friendly allowlist message (see error table). Accepted trade-off of the
  trigger approach.

## One-time operational step (not a migration)

Set starting passwords for the two existing accounts via the admin API
(`auth.admin.updateUserById` with a generated password), since existing
accounts cannot go through signup again. Passwords are generated during
implementation and handed to the user privately — never committed, never
logged in files. A throwaway script performs this; it is deleted afterwards
(not committed).

## Web app changes

### `SignInPage.jsx` (rewrite of the form logic)

- Two modes, toggled by a button-like link; one `<form>` reused:
  - **Sign in** (default): `supabase.auth.signInWithPassword({ email, password })`
  - **Create password** mode: `supabase.auth.signUp({ email, password })` —
    on success the user is signed in immediately (confirmations are off).
- The magic-link form, "email me a sign-in link" button, and related copy are
  removed entirely.
- Existing conventions preserved: `safeNext`-sanitized `next` redirect,
  single-channel screen-reader announcements, focus management on mode swap
  and on error, large tap targets, `id="main"` skip-link target.
- Submit disabled while a request is in flight.

### Error messages

| Backend outcome | Message shown (and announced assertively) |
| --- | --- |
| `invalid_credentials` / 400 on sign-in | "Wrong email or password." |
| signup blocked by trigger ("Database error saving new user") | "This email is not on the allowed list." |
| `user_already_exists` on signup | "This email already has an account — sign in instead." |
| weak password (< 6 chars) | "Password must be at least 6 characters." |
| anything else | "Could not sign you in. Please try again." |

Success announcements stay polite, matching app convention.

### Removals

- Magic-link request UI and any "check your email" confirmation state in
  `SignInPage.jsx`.

## Out of scope

- Password change / reset UI (future feature; for now the owner can reset any
  password via the Supabase dashboard or admin API).
- Removing the Brevo SMTP configuration (left in place, unused).
- Admin UI for the allowlist (dashboard table editor is the tool).
- Roles/permissions beyond what already exists.
- Re-gating email changes: the allowlist gate is INSERT-only. An existing
  allowed user can change their own account email via the confirmed
  email-change flow (`double_confirm_changes` + SMTP round-trip); that does
  not let a non-listed person create an account.

## Testing

- **SignInPage unit tests** (rewrite): sign-in success navigates to `next`/
  home; create-password success ditto; each error row above renders its
  message and announces assertively; submit disabled while pending; mode
  toggle moves focus correctly.
- **Backend E2E smoke script** (`scripts/e2e-smoke.mjs`):
  - Before creating throwaway users, the admin client inserts their emails
    into `allowed_emails`; cleanup removes them.
  - New negative test: anon `signUp` with a non-listed email fails (the
    trigger blocks it) and no user row is created.
  - Existing password sign-in steps (2a/2b) continue to pass unchanged.
- Full web test suite and vite build stay green.
