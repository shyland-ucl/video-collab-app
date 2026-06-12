# Allowlist + Password Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace magic-link sign-in with email+password gated by an `allowed_emails` allowlist enforced in the database.

**Architecture:** One migration adds `allowed_emails` (RLS, no policies) plus a `before insert on auth.users` trigger that rejects non-listed emails — server-side, unbypassable. `SignInPage` becomes a two-mode email+password form (sign in / first-time create). A one-time admin step sets passwords on the two pre-existing accounts. The E2E smoke script allowlists its throwaway users and gains a negative signup test.

**Tech Stack:** Supabase (Postgres trigger + GoTrue password auth), React 19, react-router 7, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-12-allowlist-password-auth-design.md`

Work directly on `main` (project convention). All commands run from the repo root: `C:\Users\shyla\OneDrive\Документы\GitHub\video-collab-app`.

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `supabase/migrations/0004_allowed_emails.sql` | Create | Allowlist table + signup-guard trigger |
| `web/src/pages/SignInPage.jsx` | Rewrite | Email+password sign-in / create-password form |
| `web/src/pages/SignInPage.test.jsx` | Create | Tests for the new form (none exist today) |
| `scripts/e2e-smoke.mjs` | Modify | Allowlist throwaway users; negative signup test |
| (throwaway, never committed) `scripts/_set-passwords.tmp.mjs` | Create then DELETE | One-time password set for 2 existing accounts |

Key background facts:
- `enable_confirmations = false` in `supabase/config.toml`, so `signUp` signs the user in immediately with no email.
- `minimum_password_length = 6`.
- The announcer API is `announce(message, { assertive: true })` (`web/src/utils/announcer.js:92`).
- supabase-js v2 auth errors carry a `code` (e.g. `invalid_credentials`, `user_already_exists`, `weak_password`); a trigger rejection during signup surfaces as code `unexpected_failure` with message `"Database error saving new user"`.

---

### Task 1: Migration — allowed_emails table + signup-guard trigger

**Files:**
- Create: `supabase/migrations/0004_allowed_emails.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push`
Expected: lists `0004_allowed_emails.sql`, applies without error. (Project already linked.)

- [ ] **Step 3: Verify the trigger blocks a non-listed signup**

Run (uses the anon key from `web/.env.local`, URL from `server/.env`):
```bash
node --env-file=server/.env -e "
const { readFileSync } = require('fs');
const env = Object.fromEntries(readFileSync('web/.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>[l.slice(0,l.indexOf('=')).trim(), l.slice(l.indexOf('=')+1).trim()]));
import('@supabase/supabase-js').then(async ({ createClient }) => {
  const c = createClient(process.env.SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signUp({ email: 'not-allowed-' + 'x' + '@example.com', password: 'Test123456' });
  console.log('rogue signUp →', error ? error.status + ' ' + error.message : 'NO ERROR (BAD!)');
});
"
```
Expected: an error (500, "Database error saving new user") — the trigger blocked it. If it prints `NO ERROR (BAD!)`, STOP: the trigger is not firing; clean up the created user with the admin API and investigate before continuing.

NOTE: after this step, `scripts/e2e-smoke.mjs` is temporarily broken (its throwaway users are not allowlisted) — Task 3 fixes it. Do not run the smoke script between Tasks 1 and 3.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0004_allowed_emails.sql
git commit -m "feat(db): allowed_emails allowlist enforced by auth.users trigger"
```

---

### Task 2: SignInPage — email + password with create-password mode

**Files:**
- Create: `web/src/pages/SignInPage.test.jsx`
- Rewrite: `web/src/pages/SignInPage.jsx`

- [ ] **Step 1: Write the failing tests**

Create `web/src/pages/SignInPage.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockSignIn, mockSignUp, mockUseAuth } = vi.hoisted(() => ({
  mockSignIn: vi.fn(),
  mockSignUp: vi.fn(),
  mockUseAuth: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: { auth: { signInWithPassword: mockSignIn, signUp: mockSignUp } },
}))
vi.mock('../contexts/AuthContext', () => ({ useAuth: mockUseAuth }))
vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import SignInPage from './SignInPage'
import { announce } from '../utils/announcer'

function renderAt(path = '/signin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/" element={<p>Home stub</p>} />
        <Route path="/projects/:id" element={<p>Project stub</p>} />
      </Routes>
    </MemoryRouter>
  )
}

async function fillAndSubmit(email, password, buttonName) {
  await userEvent.type(screen.getByLabelText('Email address'), email)
  await userEvent.type(screen.getByLabelText('Password'), password)
  await userEvent.click(screen.getByRole('button', { name: buttonName }))
}

describe('SignInPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseAuth.mockReturnValue({ session: null })
  })

  it('renders the email + password sign-in form by default', () => {
    renderAt()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    ).toBeInTheDocument()
  })

  it('signs in with email and password', async () => {
    mockSignIn.mockResolvedValue({ data: {}, error: null })
    renderAt()
    await fillAndSubmit('a@b.com', 'secret123', 'Sign in')
    expect(mockSignIn).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret123' })
  })

  it('redirects to the sanitized next target when a session exists', () => {
    mockUseAuth.mockReturnValue({ session: { user: { id: 'u1' } } })
    renderAt('/signin?next=/projects/p1')
    expect(screen.getByText('Project stub')).toBeInTheDocument()
  })

  it('falls back to home for unsafe next values', () => {
    mockUseAuth.mockReturnValue({ session: { user: { id: 'u1' } } })
    renderAt('/signin?next=//evil.com')
    expect(screen.getByText('Home stub')).toBeInTheDocument()
  })

  it('switches to create mode, focuses email, announces, and signs up', async () => {
    mockSignUp.mockResolvedValue({ data: {}, error: null })
    renderAt()
    await userEvent.click(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    )
    expect(screen.getByRole('heading', { name: 'Create your password' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toHaveFocus()
    expect(announce).toHaveBeenCalledWith('Create your password')
    await fillAndSubmit('new@b.com', 'secret123', 'Create password and sign in')
    expect(mockSignUp).toHaveBeenCalledWith({ email: 'new@b.com', password: 'secret123' })
  })

  it('shows wrong-password message assertively on invalid credentials', async () => {
    mockSignIn.mockResolvedValue({
      data: null,
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    })
    renderAt()
    await fillAndSubmit('a@b.com', 'wrongpass', 'Sign in')
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('Wrong email or password.', { assertive: true })
  })

  it('maps the allowlist trigger rejection on signup', async () => {
    mockSignUp.mockResolvedValue({
      data: null,
      error: { code: 'unexpected_failure', message: 'Database error saving new user' },
    })
    renderAt()
    await userEvent.click(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    )
    await fillAndSubmit('rogue@b.com', 'secret123', 'Create password and sign in')
    expect(
      await screen.findByText('This email is not on the allowed list.')
    ).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('This email is not on the allowed list.', {
      assertive: true,
    })
  })

  it.each([
    ['user_already_exists', 'This email already has an account — sign in instead.'],
    ['weak_password', 'Password must be at least 6 characters.'],
    ['some_unknown_code', 'Could not sign you in. Please try again.'],
  ])('signup error %s shows its message', async (code, message) => {
    mockSignUp.mockResolvedValue({ data: null, error: { code, message: 'x' } })
    renderAt()
    await userEvent.click(
      screen.getByRole('button', { name: 'First time here? Create your password' })
    )
    await fillAndSubmit('a@b.com', 'secret123', 'Create password and sign in')
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('disables the submit button while a request is in flight', async () => {
    mockSignIn.mockReturnValue(new Promise(() => {})) // never resolves
    renderAt()
    await fillAndSubmit('a@b.com', 'secret123', 'Sign in')
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm run test -w web -- --run src/pages/SignInPage.test.jsx`
Expected: nearly all FAIL (current page has no Password field; magic-link form instead).

- [ ] **Step 3: Rewrite the component**

Replace the whole of `web/src/pages/SignInPage.jsx` with:

```jsx
import { useRef, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'
import { safeNext } from '../lib/safeNext'

const AUTH_ERRORS = {
  invalid_credentials: 'Wrong email or password.',
  user_already_exists: 'This email already has an account — sign in instead.',
  weak_password: 'Password must be at least 6 characters.',
}
const NOT_ALLOWED = 'This email is not on the allowed list.'
const GENERIC = 'Could not sign you in. Please try again.'

// The allowlist trigger rejection reaches the client as a generic DB error
function describeError(error, mode) {
  if (mode === 'create' && error.message?.includes('Database error')) {
    return NOT_ALLOWED
  }
  return AUTH_ERRORS[error.code] ?? GENERIC
}

export default function SignInPage() {
  const { session } = useAuth()
  const [params] = useSearchParams()
  const [mode, setMode] = useState('signin') // 'signin' | 'create'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const emailRef = useRef(null)
  const next = safeNext(params.get('next'))

  if (session) return <Navigate to={next} replace />

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    const credentials = { email, password }
    const { error } =
      mode === 'create'
        ? await supabase.auth.signUp(credentials)
        : await supabase.auth.signInWithPassword(credentials)
    setBusy(false)
    if (error) {
      const message = describeError(error, mode)
      setError(message)
      announce(message, { assertive: true })
      return
    }
    // success: AuthContext picks up the session and <Navigate> above redirects
  }

  function switchMode(nextMode) {
    setMode(nextMode)
    setError(null)
    announce(nextMode === 'create' ? 'Create your password' : 'Sign in')
    emailRef.current?.focus()
  }

  const heading = mode === 'create' ? 'Create your password' : 'Sign in'

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-bold">{heading}</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="email" className="mb-2 block text-lg">
          Email address
        </label>
        <input
          id="email"
          ref={emailRef}
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 block w-full rounded border border-gray-400 p-3 text-lg"
        />
        <label htmlFor="password" className="mb-2 block text-lg">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={6}
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 block w-full rounded border border-gray-400 p-3 text-lg"
        />
        <button
          type="submit"
          disabled={busy}
          className="min-h-12 w-full rounded bg-blue-700 px-4 py-3 text-lg font-semibold text-white disabled:opacity-50"
        >
          {mode === 'create'
            ? busy
              ? 'Creating…'
              : 'Create password and sign in'
            : busy
              ? 'Signing in…'
              : 'Sign in'}
        </button>
        {error && <p className="mt-3 text-red-700">{error}</p>}
      </form>
      {mode === 'create' ? (
        <button
          type="button"
          onClick={() => switchMode('signin')}
          className="mt-4 min-h-12 underline"
        >
          Already have a password? Sign in
        </button>
      ) : (
        <button
          type="button"
          onClick={() => switchMode('create')}
          className="mt-4 min-h-12 underline"
        >
          First time here? Create your password
        </button>
      )}
    </main>
  )
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm run test -w web -- --run src/pages/SignInPage.test.jsx`
Expected: 11 passed.

- [ ] **Step 5: Run the whole web suite (RequireAuth tests touch the sign-in route)**

Run: `npm run test -w web -- --run`
Expected: all pass (27 existing + 11 new = 38; if RequireAuth tests asserted magic-link copy, fix the expectation to the new copy and call it out).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/SignInPage.jsx web/src/pages/SignInPage.test.jsx
git commit -m "feat(web): email+password sign-in with allowlist-gated first-time password creation"
```

---

### Task 3: E2E smoke — allowlist throwaway users + negative signup test

**Files:**
- Modify: `scripts/e2e-smoke.mjs`

- [ ] **Step 1: Allowlist the throwaway emails before user creation**

Insert this block at the very top of `runTests()`, before the existing Step 1:

```js
  // -------------------------------------------------------------------------
  // Step 0 — Allowlist the throwaway emails (signup trigger blocks others)
  // -------------------------------------------------------------------------
  {
    const { error } = await adminClient
      .from('allowed_emails')
      .insert([{ email: creatorEmail }, { email: helperEmail }]);
    assert(!error, '0: allowlist throwaway emails', `${creatorEmail}, ${helperEmail}`, error?.message);
  }
```

- [ ] **Step 2: Add the negative signup test after Step 12**

```js
  // -------------------------------------------------------------------------
  // Step 13 — A non-listed email cannot create an account (allowlist trigger)
  // -------------------------------------------------------------------------
  {
    const rogueEmail = `e2e-rogue-${ts}@example.com`;
    const rogue = makeAnonClient();
    const { error: signUpErr } = await rogue.auth.signUp({ email: rogueEmail, password });
    assert(
      signUpErr !== null,
      '13a: non-listed signup is blocked',
      `error=${signUpErr?.message}`,
      'expected signup to fail but it succeeded'
    );
    const { error: signInErr } = await rogue.auth.signInWithPassword({
      email: rogueEmail,
      password,
    });
    assert(
      signInErr !== null,
      '13b: no usable account exists for the rogue email',
      `error=${signInErr?.message}`,
      'expected sign-in to fail but it succeeded'
    );
  }
```

Also update the doc comment at the top of the file: append `, allowlist enforcement` to the `Tests:` line.

- [ ] **Step 3: Remove the throwaway emails in cleanup**

Insert at the very top of `cleanup()` (before C1):

```js
  // Step C0: remove throwaway emails from the allowlist
  {
    const { error } = await adminClient
      .from('allowed_emails')
      .delete()
      .in('email', [creatorEmail, helperEmail]);
    if (error) console.error(`  WARN  cleanup: allowlist removal failed — ${error.message}`);
    else console.log('  OK    removed throwaway emails from allowlist');
  }
```

- [ ] **Step 4: Run the smoke script live**

Run: `node --env-file=server/.env scripts/e2e-smoke.mjs`
Expected: all PASS including new 0, 13a, 13b; `0 failed`; exit 0; cleanup shows the allowlist rows removed.

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-smoke.mjs
git commit -m "test: E2E smoke allowlists throwaway users, verifies signup gate"
```

---

### Task 4: One-time ops — set passwords for the two existing accounts

This is an operational step for the CONTROLLER (not a code change; nothing is committed). The two pre-existing accounts cannot go through signup again, so their passwords are set via the admin API.

- [ ] **Step 1: Create the throwaway script** `scripts/_set-passwords.tmp.mjs` (never commit):

```js
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const targets = ['l.xiao.22@ucl.ac.uk', 'shylandforlizi@gmail.com']

const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
if (error) throw error
for (const email of targets) {
  const user = data.users.find((u) => u.email?.toLowerCase() === email)
  if (!user) {
    console.log(`SKIP ${email} — no existing account`)
    continue
  }
  const password = crypto.randomBytes(9).toString('base64url') // ~12 chars
  const { error: upErr } = await admin.auth.admin.updateUserById(user.id, { password })
  console.log(upErr ? `FAIL ${email}: ${upErr.message}` : `OK ${email} -> ${password}`)
}
```

- [ ] **Step 2: Run it:** `node --env-file=server/.env scripts/_set-passwords.tmp.mjs`
Expected: `OK <email> -> <password>` for each existing account (SKIP is fine if an account does not exist — that email can self-serve via Create your password instead).

- [ ] **Step 3: Deliver the passwords to the user privately** (chat), with a note they can be changed any time via the Supabase dashboard (Authentication → Users → … → Reset password).

- [ ] **Step 4: Delete the script:** `rm scripts/_set-passwords.tmp.mjs` and verify `git status` shows no trace of it.

---

### Task 5: Final verification

- [ ] **Step 1:** `npm test` — all green (38 web + 7 server = 45).
- [ ] **Step 2:** `npm run build` — clean.
- [ ] **Step 3:** `git grep -n "signInWithOtp\|magic" -- web/src` — zero matches.
- [ ] **Step 4:** `git status` — clean tree except the pre-existing `scripts/diag-smtp.mjs` modification (leave it).
- [ ] **Step 5:** Confirm with the user before `git push` (deploys via Vercel).
