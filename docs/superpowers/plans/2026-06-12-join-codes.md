# 4-Digit Join Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the invite-link flow with short-lived 4-digit join codes: host generates a code on the project page, collaborator types it into a "Join with a code" box on their home page.

**Architecture:** One Supabase migration adds a `code` column to `invites`, two `security definer` RPCs (`create_invite`, `redeem_code` — both return jsonb), a `code_attempts` rate-limit table, and tightened RLS. The web app swaps the link UI for code display (ProjectPage) and a join box (ProjectsPage); `JoinPage`/`inviteUrl`/`/join/:token` are deleted.

**Tech Stack:** Supabase (Postgres + RLS + plpgsql), React 19, react-router 7, Vitest + Testing Library, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-06-12-join-code-design.md`

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `supabase/migrations/0003_join_codes.sql` | Create | Schema + RPCs + RLS for codes |
| `web/src/pages/ProjectPage.jsx` | Modify | Host: generate + display code |
| `web/src/pages/ProjectPage.test.jsx` | Rewrite | Tests for code display |
| `web/src/pages/ProjectsPage.jsx` | Modify | Collaborator: join-with-code box |
| `web/src/pages/ProjectsPage.test.jsx` | Modify | Tests for join box |
| `web/src/App.jsx` | Modify | Remove `/join/:token` route |
| `web/src/pages/JoinPage.jsx` + test | Delete | Link flow removed |
| `web/src/lib/inviteUrl.js` + test | Delete | Link flow removed |
| `scripts/e2e-smoke.mjs` | Modify | Exercise code flow end to end |

All commands run from the repo root: `C:\Users\shyla\OneDrive\Документы\GitHub\video-collab-app`.

---

### Task 1: Migration — codes, RPCs, rate limiting, RLS

**Files:**
- Create: `supabase/migrations/0003_join_codes.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push`
Expected: lists `0003_join_codes.sql`, confirm, finishes without error.
(The project is already linked — see `supabase/.temp/project-ref`. If it asks for the database password, get it from the Supabase dashboard → Project Settings → Database.)

- [ ] **Step 3: Verify the functions exist and are auth-gated**

Run:
```bash
node --env-file=server/.env -e "
import('@supabase/supabase-js').then(async ({ createClient }) => {
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY ?? 'missing');
  const { error } = await c.rpc('redeem_code', { p_code: '0000' });
  console.log('redeem_code unauthenticated →', error?.message);
});"
```
Expected: an error mentioning `not_authenticated` (or a 401/permission error) — proving the function exists and rejects anonymous callers. (If `SUPABASE_ANON_KEY` is not in `server/.env`, read `VITE_SUPABASE_ANON_KEY` from `web/.env.local` instead.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_join_codes.sql
git commit -m "feat(db): 4-digit join codes — create_invite/redeem_code RPCs, rate limiting, tightened invites RLS"
```

---

### Task 2: ProjectPage shows a code instead of a link

**Files:**
- Modify: `web/src/pages/ProjectPage.jsx`
- Rewrite: `web/src/pages/ProjectPage.test.jsx`

- [ ] **Step 1: Rewrite the test file (failing tests first)**

Replace the whole of `web/src/pages/ProjectPage.test.jsx` with:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const { mockProjectSingle, mockMembersEq, mockRpc } = vi.hoisted(() => ({
  mockProjectSingle: vi.fn(),
  mockMembersEq: vi.fn(),
  mockRpc: vi.fn(),
}))

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn((table) => {
      if (table === 'projects') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({ single: mockProjectSingle })),
          })),
        }
      }
      if (table === 'project_members') {
        return {
          select: vi.fn(() => ({
            eq: mockMembersEq,
          })),
        }
      }
      return {}
    }),
    rpc: mockRpc,
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}))

vi.mock('../utils/announcer', () => ({ announce: vi.fn() }))

import ProjectPage from './ProjectPage'
import { announce } from '../utils/announcer'

function renderAt(projectId = 'p1') {
  return render(
    <MemoryRouter initialEntries={[`/projects/${projectId}`]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>
  )
}

const PROJECT = { id: 'p1', title: 'My film', owner_id: 'u1' }
const MEMBERS = [
  { user_id: 'u1', role: 'creator' },
  { user_id: 'u2', role: 'helper' },
]

describe('ProjectPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders project title and members with "(you)" marker after load', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })

    renderAt()

    expect(await screen.findByText('My film')).toBeInTheDocument()
    expect(screen.getByText('People (2)')).toBeInTheDocument()
    expect(screen.getByText('Creator (you)')).toBeInTheDocument()
    expect(screen.getByText('Helper')).toBeInTheDocument()
  })

  it('shows not-found error and back link when project load errors', async () => {
    mockProjectSingle.mockResolvedValue({ data: null, error: { message: 'not found' } })

    renderAt()

    expect(
      await screen.findByText('Project not found, or you are not a member of it.')
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument()
  })

  it('shows the 4-digit code with expiry note and announces it', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc.mockResolvedValue({
      data: { code: '4827', expires_at: '2026-06-12T12:00:00Z' },
      error: null,
    })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    expect(await screen.findByText('4827')).toBeInTheDocument()
    expect(screen.getByText('Expires in 15 minutes.')).toBeInTheDocument()
    expect(
      screen.getByText('Ask your helper to enter this code on their home page.')
    ).toBeInTheDocument()
    expect(mockRpc).toHaveBeenCalledWith('create_invite', { p_project_id: 'p1' })
    await waitFor(() =>
      expect(announce).toHaveBeenCalledWith('Invite code created: 4 8 2 7')
    )
  })

  it('a second press replaces the code with a fresh one', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc
      .mockResolvedValueOnce({
        data: { code: '4827', expires_at: '2026-06-12T12:00:00Z' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { code: '9151', expires_at: '2026-06-12T12:20:00Z' },
        error: null,
      })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))
    await screen.findByText('4827')
    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    expect(await screen.findByText('9151')).toBeInTheDocument()
    expect(screen.queryByText('4827')).not.toBeInTheDocument()
  })

  it('rpc error announces failure and shows friendly error text', async () => {
    mockProjectSingle.mockResolvedValue({ data: PROJECT, error: null })
    mockMembersEq.mockResolvedValue({ data: MEMBERS, error: null })
    mockRpc.mockResolvedValue({ data: null, error: { message: 'not_owner' } })

    renderAt()
    await screen.findByText('My film')

    await userEvent.click(screen.getByRole('button', { name: 'Invite a helper' }))

    await waitFor(() => expect(announce).toHaveBeenCalledWith('Could not create invite code'))
    expect(
      screen.getByText('Could not create a code. Only the project owner can invite.')
    ).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests — expect new ones to FAIL**

Run: `npm run test -w web -- --run src/pages/ProjectPage.test.jsx`
Expected: the first two tests pass; the three invite tests FAIL (component still inserts into `invites` and renders a link).

- [ ] **Step 3: Update the component**

Replace the whole of `web/src/pages/ProjectPage.jsx` with:

```jsx
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'

export default function ProjectPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [project, setProject] = useState(null)
  const [members, setMembers] = useState([])
  const [invite, setInvite] = useState(null) // { code, expires_at }
  const [error, setError] = useState(null)
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: proj, error: projErr } = await supabase
        .from('projects')
        .select('id, title, owner_id')
        .eq('id', id)
        .single()
      if (projErr) {
        setError('Project not found, or you are not a member of it.')
        return
      }
      setProject(proj)
      const { data: mems } = await supabase
        .from('project_members')
        .select('user_id, role, created_at')
        .eq('project_id', id)
      setMembers(mems ?? [])
    }
    load()
  }, [id])

  async function handleInvite() {
    if (inviting) return
    setInviting(true)
    setError(null)
    try {
      const { data, error } = await supabase.rpc('create_invite', { p_project_id: id })
      if (error) {
        setError('Could not create a code. Only the project owner can invite.')
        announce('Could not create invite code')
        return
      }
      setInvite(data)
      announce(`Invite code created: ${data.code.split('').join(' ')}`)
    } finally {
      setInviting(false)
    }
  }

  if (error && !project) {
    return (
      <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
        <p className="text-red-700">{error}</p>
        <Link to="/" className="underline">Back to projects</Link>
      </main>
    )
  }
  if (!project) {
    return (
      <main id="main" tabIndex={-1} className="p-4">
        <p>Loading…</p>
      </main>
    )
  }

  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <Link to="/" className="mb-4 inline-block underline">← All projects</Link>
      <h1 className="mb-4 text-2xl font-bold">{project.title}</h1>

      <section aria-labelledby="members-heading" className="mb-6">
        <h2 id="members-heading" className="mb-2 text-xl font-semibold">
          People ({members.length})
        </h2>
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.user_id} className="rounded border border-gray-300 p-2">
              {m.role === 'creator' ? 'Creator' : 'Helper'}
              {m.user_id === user?.id ? ' (you)' : ''}
            </li>
          ))}
        </ul>
      </section>

      <button
        onClick={handleInvite}
        disabled={inviting}
        className="min-h-12 w-full rounded bg-blue-700 px-4 py-3 text-lg font-semibold text-white disabled:opacity-50"
      >
        Invite a helper
      </button>
      {error && <p className="mt-3 text-red-700">{error}</p>}
      {invite && (
        <div className="mt-3 rounded border border-gray-300 p-4 text-center">
          <p className="text-5xl font-bold tracking-[0.4em]">{invite.code}</p>
          <p className="mt-3 text-lg">Expires in 15 minutes.</p>
          <p className="text-lg">Ask your helper to enter this code on their home page.</p>
        </div>
      )}
    </main>
  )
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npm run test -w web -- --run src/pages/ProjectPage.test.jsx`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ProjectPage.jsx web/src/pages/ProjectPage.test.jsx
git commit -m "feat(web): project page generates and displays 4-digit invite code"
```

---

### Task 3: ProjectsPage gains the "Join with a code" box

**Files:**
- Modify: `web/src/pages/ProjectsPage.jsx`
- Modify: `web/src/pages/ProjectsPage.test.jsx`

- [ ] **Step 1: Add failing tests**

In `web/src/pages/ProjectsPage.test.jsx`:

(a) Extend the hoisted mocks and the supabase mock to include `rpc` — replace the existing `vi.hoisted` + `vi.mock('../lib/supabaseClient', …)` block with:

```jsx
const { mockOrder, mockSingle, mockInsert, mockRpc } = vi.hoisted(() => {
  const mockOrder = vi.fn()
  const mockSingle = vi.fn()
  const mockInsert = vi.fn(() => ({ select: vi.fn(() => ({ single: mockSingle })) }))
  const mockRpc = vi.fn()
  return { mockOrder, mockSingle, mockInsert, mockRpc }
})
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ order: mockOrder })),
      insert: mockInsert,
    })),
    rpc: mockRpc,
  },
}))
```

(b) Replace `renderPage` so navigation can be asserted (existing tests keep working — `/` still renders ProjectsPage):

```jsx
import { MemoryRouter, Routes, Route } from 'react-router-dom'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<p>Project page stub</p>} />
      </Routes>
    </MemoryRouter>
  )
}
```

(c) Append this describe block at the end of the file:

```jsx
describe('ProjectsPage — join with a code', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOrder.mockResolvedValue({ data: [], error: null })
  })

  async function typeCodeAndJoin(code) {
    await screen.findByText(/No projects yet/)
    await userEvent.type(screen.getByLabelText('Join with a code'), code)
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
  }

  it('redeems the code and navigates to the project', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, project_id: 'p9' }, error: null })
    renderPage()
    await typeCodeAndJoin('4827')
    expect(mockRpc).toHaveBeenCalledWith('redeem_code', { p_code: '4827' })
    expect(await screen.findByText('Project page stub')).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('Joined project')
  })

  it.each([
    ['invalid_code', "That code didn't work. Check the digits and try again."],
    ['expired_code', 'This code has expired. Ask for a new one.'],
    ['too_many_attempts', 'Too many tries. Please wait 15 minutes.'],
  ])('shows the right message for %s', async (reason, message) => {
    mockRpc.mockResolvedValue({ data: { ok: false, reason }, error: null })
    renderPage()
    await typeCodeAndJoin('0000')
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(announce).toHaveBeenCalledWith('Could not join the project')
  })

  it('shows a generic message on transport error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'network' } })
    renderPage()
    await typeCodeAndJoin('1234')
    expect(
      await screen.findByText('Could not join the project. Please try again.')
    ).toBeInTheDocument()
  })

  it('disables the Join button while redemption is in flight', async () => {
    mockRpc.mockReturnValue(new Promise(() => {})) // never resolves
    renderPage()
    await typeCodeAndJoin('4827')
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run the tests — expect the new block to FAIL**

Run: `npm run test -w web -- --run src/pages/ProjectsPage.test.jsx`
Expected: existing 4 tests pass; the 6 new ones FAIL ("Join with a code" label not found).

- [ ] **Step 3: Implement the join box**

In `web/src/pages/ProjectsPage.jsx`:

(a) Update imports and add state/handler at the top of the component:

```jsx
import { Link, useNavigate } from 'react-router-dom'
```

```jsx
const JOIN_ERRORS = {
  invalid_code: "That code didn't work. Check the digits and try again.",
  expired_code: 'This code has expired. Ask for a new one.',
  too_many_attempts: 'Too many tries. Please wait 15 minutes.',
}
```

Inside the component (after the existing `useState` calls):

```jsx
const navigate = useNavigate()
const [joinCode, setJoinCode] = useState('')
const [joining, setJoining] = useState(false)
const [joinError, setJoinError] = useState(null)

async function handleJoin(e) {
  e.preventDefault()
  if (joining) return
  setJoining(true)
  setJoinError(null)
  const { data, error } = await supabase.rpc('redeem_code', { p_code: joinCode })
  setJoining(false)
  if (error || !data?.ok) {
    setJoinError(
      JOIN_ERRORS[data?.reason] ?? 'Could not join the project. Please try again.'
    )
    announce('Could not join the project')
    return
  }
  setJoinCode('')
  announce('Joined project')
  navigate(`/projects/${data.project_id}`)
}
```

(b) Render the join form between the create form and the error/list block (after the `</form>` of the create form):

```jsx
<form onSubmit={handleJoin} className="mb-6">
  <label htmlFor="join-code" className="mb-2 block text-lg">
    Join with a code
  </label>
  <div className="flex gap-2">
    <input
      id="join-code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{4}"
      maxLength={4}
      required
      value={joinCode}
      onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ''))}
      className="block w-full rounded border border-gray-400 p-3 text-lg tracking-widest"
    />
    <button
      type="submit"
      disabled={joining}
      className="min-h-12 shrink-0 rounded bg-blue-700 px-4 font-semibold text-white disabled:opacity-50"
    >
      Join
    </button>
  </div>
  {joinError && <p className="mt-2 text-red-700">{joinError}</p>}
</form>
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npm run test -w web -- --run src/pages/ProjectsPage.test.jsx`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ProjectsPage.jsx web/src/pages/ProjectsPage.test.jsx
git commit -m "feat(web): join-with-a-code box on projects page"
```

---

### Task 4: Remove the link flow (JoinPage, inviteUrl, route)

**Files:**
- Modify: `web/src/App.jsx`
- Delete: `web/src/pages/JoinPage.jsx`, `web/src/pages/JoinPage.test.jsx`, `web/src/lib/inviteUrl.js`, `web/src/lib/inviteUrl.test.js`

- [ ] **Step 1: Remove the route and import from App.jsx**

In `web/src/App.jsx`, delete these two lines:

```jsx
import JoinPage from './pages/JoinPage'
```

```jsx
        <Route path="/join/:token" element={<JoinPage />} />
```

- [ ] **Step 2: Delete the dead files**

```bash
git rm web/src/pages/JoinPage.jsx web/src/pages/JoinPage.test.jsx web/src/lib/inviteUrl.js web/src/lib/inviteUrl.test.js
```

- [ ] **Step 3: Run the full web test suite and the build**

Run: `npm test`
Expected: all remaining tests pass, none reference JoinPage/inviteUrl.

Run: `npm run build`
Expected: vite build succeeds (catches any lingering import of the deleted files).

- [ ] **Step 4: Commit**

```bash
git add web/src/App.jsx
git commit -m "refactor(web): remove invite-link flow (JoinPage, inviteUrl, /join route)"
```

---

### Task 5: Update the backend E2E smoke script

**Files:**
- Modify: `scripts/e2e-smoke.mjs`

- [ ] **Step 1: Update the header comment and variables**

Replace the line `let inviteToken = null;` with:

```js
let inviteCode = null;
let inviteCode2 = null;
```

Update the doc comment at the top: replace `redeem_invite RPC` with `create_invite/redeem_code RPCs` and `invalid-token rejection` with `invalid-code rejection`.

- [ ] **Step 2: Replace Step 7 (invite creation)**

Replace the whole Step 7 block with:

```js
  // -------------------------------------------------------------------------
  // Step 7 — Creator generates an invite code via RPC; direct insert is blocked
  // -------------------------------------------------------------------------
  {
    const { data, error } = await creatorClient.rpc('create_invite', {
      p_project_id: projectId,
    });
    assert(
      !error && /^[0-9]{4}$/.test(data?.code ?? ''),
      '7a: creator creates invite code via RPC',
      `code=${data?.code}, expires=${data?.expires_at}`,
      error?.message ?? `unexpected data=${JSON.stringify(data)}`
    );
    inviteCode = data.code;

    const { error: insertErr } = await creatorClient
      .from('invites')
      .insert({ project_id: projectId, created_by: creatorId, code: '1234' });
    assert(
      insertErr !== null,
      '7b: direct insert into invites is blocked (RLS tightened)',
      `error code=${insertErr?.code}`,
      'expected RLS error but insert succeeded'
    );
  }
```

- [ ] **Step 3: Replace Step 9 (redemption)**

Replace the whole Step 9 block with:

```js
  // -------------------------------------------------------------------------
  // Step 9 — Helper redeems the code
  // -------------------------------------------------------------------------
  {
    const { data, error } = await helperClient.rpc('redeem_code', { p_code: inviteCode });
    assert(
      !error && data?.ok === true && data?.project_id === projectId,
      '9: helper redeems code',
      `project_id=${data?.project_id}`,
      error?.message ?? `unexpected data=${JSON.stringify(data)}`
    );
  }
```

- [ ] **Step 4: Replace Steps 11 and 12 (reuse + invalid code)**

Replace the whole Step 11 and Step 12 blocks with:

```js
  // -------------------------------------------------------------------------
  // Step 11 — A used code cannot be redeemed again; a fresh code is safe for
  //           an existing member (membership stays at 2)
  // -------------------------------------------------------------------------
  {
    const { data: again } = await helperClient.rpc('redeem_code', { p_code: inviteCode });
    assert(
      again?.ok === false && again?.reason === 'invalid_code',
      '11a: used code is rejected as invalid_code',
      `reason=${again?.reason}`,
      `unexpected data=${JSON.stringify(again)}`
    );

    const { data: fresh, error: freshErr } = await creatorClient.rpc('create_invite', {
      p_project_id: projectId,
    });
    assert(!freshErr && fresh?.code, '11b: creator creates second code', `code=${fresh?.code}`, freshErr?.message);
    inviteCode2 = fresh.code;

    const { data: rejoin } = await helperClient.rpc('redeem_code', { p_code: inviteCode2 });
    assert(
      rejoin?.ok === true && rejoin?.project_id === projectId,
      '11c: existing member redeems fresh code (idempotent membership)',
      `project_id=${rejoin?.project_id}`,
      `unexpected data=${JSON.stringify(rejoin)}`
    );

    const { data: mRows, error: me } = await helperClient
      .from('project_members')
      .select('user_id')
      .eq('project_id', projectId);
    assert(
      !me && mRows?.length === 2,
      '11d: membership still has 2 rows',
      `rows=${mRows?.length}`,
      me?.message ?? `rows=${mRows?.length}`
    );
  }

  // -------------------------------------------------------------------------
  // Step 12 — Wrong code returns invalid_code (all codes are used by now)
  // -------------------------------------------------------------------------
  {
    const { data, error } = await creatorClient.rpc('redeem_code', { p_code: '0042' });
    assert(
      !error && data?.ok === false && data?.reason === 'invalid_code',
      '12: wrong code returns invalid_code',
      `reason=${data?.reason}`,
      error?.message ?? `unexpected data=${JSON.stringify(data)}`
    );
  }
```

- [ ] **Step 5: Update cleanup step C2 (FK SET NULL check) to look up by code**

In the `cleanup()` function, replace the `if (projectId && inviteToken) {` block with:

```js
  // Step C2: Verify invite.used_by is now NULL (FK SET NULL path)
  if (projectId && inviteCode) {
    const { data, error } = await adminClient
      .from('invites')
      .select('used_by, code')
      .eq('project_id', projectId)
      .eq('code', inviteCode)
      .single();
    if (error) {
      console.error(`  WARN  cleanup: reading invite after helper delete — ${error.message}`);
    } else if (data.used_by === null) {
      console.log(`  OK    invite.used_by is NULL after helper deletion (FK SET NULL works)`);
      pass('C: invite.used_by SET NULL after helper user delete', 'FK path verified');
    } else {
      fail('C: invite.used_by SET NULL after helper user delete', `still has used_by=${data.used_by}`);
    }
  }
```

- [ ] **Step 6: Run the smoke script against the live backend**

Run: `node --env-file=server/.env scripts/e2e-smoke.mjs`
Expected: all steps PASS (including new 7a/7b, 9, 11a–11d, 12, C), `0 failed`, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e-smoke.mjs
git commit -m "test: E2E smoke covers create_invite/redeem_code flow and tightened RLS"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all web tests pass.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean vite build.

- [ ] **Step 3: Grep for leftovers**

Run: `git grep -n "redeem_invite\|inviteUrl\|/join/" -- web scripts supabase/migrations/0003_join_codes.sql`
Expected: no matches in app code (matches inside `supabase/migrations/0001*/0002*` history files are fine and expected — those are immutable history).

- [ ] **Step 4: Commit anything outstanding**

```bash
git status
```
Expected: clean tree (everything committed in Tasks 1–5).
