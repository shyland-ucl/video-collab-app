/**
 * Backend E2E smoke test for video-collab-app
 *
 * Tests: auth, RLS policies, owner-membership trigger, create_invite/redeem_code RPCs,
 *        idempotency, invalid-code rejection, FK SET NULL on user delete, allowlist enforcement.
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/e2e-smoke.mjs
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server/.env
 * Reads VITE_SUPABASE_ANON_KEY from web/.env.local automatically.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');

/** Parse a .env file into a plain object (handles KEY=VALUE, ignores comments). */
function parseEnvFile(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

// Load anon key from web/.env.local
const webEnv = parseEnvFile(join(repoRoot, 'web', '.env.local'));
const ANON_KEY = webEnv['VITE_SUPABASE_ANON_KEY'];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).');
  process.exit(1);
}
if (!ANON_KEY) {
  console.error('VITE_SUPABASE_ANON_KEY not found in web/.env.local.');
  process.exit(1);
}

// Result tracking
const results = [];
let failureCount = 0;

function pass(step, detail = '') {
  const msg = `  PASS  [${step}]${detail ? ' — ' + detail : ''}`;
  console.log(msg);
  results.push({ step, status: 'PASS', detail });
}

function fail(step, detail) {
  const msg = `  FAIL  [${step}] — ${detail}`;
  console.error(msg);
  results.push({ step, status: 'FAIL', detail });
  failureCount++;
}

function assert(condition, step, successDetail, failDetail) {
  if (condition) {
    pass(step, successDetail);
  } else {
    fail(step, failDetail);
    throw new Error(`Assertion failed at step: ${step} — ${failDetail}`);
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function makeAnonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Main test run
// ---------------------------------------------------------------------------

const ts = Date.now();
const creatorEmail = `e2e-creator-${ts}@example.com`;
const helperEmail = `e2e-helper-${ts}@example.com`;
const password = `Smoke!${crypto.randomBytes(8).toString('hex')}`;

let creatorId = null;
let helperId = null;
let creatorClient = null;
let helperClient = null;
let projectId = null;
let inviteCode = null;
let inviteCode2 = null;

console.log('\n=== video-collab-app backend E2E smoke ===\n');
console.log(`  Supabase URL : ${SUPABASE_URL}`);
console.log(`  Creator email: ${creatorEmail}`);
console.log(`  Helper  email: ${helperEmail}`);
console.log('');

async function runTests() {
  // -------------------------------------------------------------------------
  // Step 0 — Allowlist the throwaway emails (signup trigger blocks others)
  // -------------------------------------------------------------------------
  {
    const { error } = await adminClient
      .from('allowed_emails')
      .insert([{ email: creatorEmail }, { email: helperEmail }]);
    assert(!error, '0: allowlist throwaway emails', `${creatorEmail}, ${helperEmail}`, error?.message);
  }

  // -------------------------------------------------------------------------
  // Step 1 — Admin creates test users
  // -------------------------------------------------------------------------
  {
    const { data: cu, error: ce } = await adminClient.auth.admin.createUser({
      email: creatorEmail,
      password,
      email_confirm: true,
    });
    assert(!ce, '1a: admin create creator', `id=${cu?.user?.id}`, ce?.message);
    creatorId = cu.user.id;

    const { data: hu, error: he } = await adminClient.auth.admin.createUser({
      email: helperEmail,
      password,
      email_confirm: true,
    });
    assert(!he, '1b: admin create helper', `id=${hu?.user?.id}`, he?.message);
    helperId = hu.user.id;
  }

  // -------------------------------------------------------------------------
  // Step 2 — Sign in both users with anon clients
  // -------------------------------------------------------------------------
  {
    creatorClient = makeAnonClient();
    const { data: cs, error: ce } = await creatorClient.auth.signInWithPassword({
      email: creatorEmail,
      password,
    });
    assert(!ce && cs?.user?.id === creatorId, '2a: creator signIn', `uid=${cs?.user?.id}`, ce?.message ?? 'uid mismatch');

    helperClient = makeAnonClient();
    const { data: hs, error: he } = await helperClient.auth.signInWithPassword({
      email: helperEmail,
      password,
    });
    assert(!he && hs?.user?.id === helperId, '2b: helper signIn', `uid=${hs?.user?.id}`, he?.message ?? 'uid mismatch');
  }

  // -------------------------------------------------------------------------
  // Step 3 — Creator inserts a project
  // -------------------------------------------------------------------------
  {
    const { data, error } = await creatorClient
      .from('projects')
      .insert({ title: 'E2E smoke project', owner_id: creatorId })
      .select('id, title, owner_id')
      .single();
    assert(!error && data?.id, '3: creator inserts project', `project_id=${data?.id}`, error?.message);
    projectId = data.id;
  }

  // -------------------------------------------------------------------------
  // Step 4 — Trigger: creator is auto-added as project_member with role 'creator'
  // -------------------------------------------------------------------------
  {
    const { data, error } = await creatorClient
      .from('project_members')
      .select('user_id, role')
      .eq('project_id', projectId);
    assert(!error, '4a: creator reads project_members', `rows=${data?.length}`, error?.message);
    assert(
      data?.length === 1 && data[0].user_id === creatorId && data[0].role === 'creator',
      '4b: trigger auto-added creator member',
      `rows=${data?.length}, role=${data?.[0]?.role}`,
      `rows=${data?.length}, row=${JSON.stringify(data?.[0])}`
    );
  }

  // -------------------------------------------------------------------------
  // Step 5 — RLS negative: helper cannot read the project before joining
  // -------------------------------------------------------------------------
  {
    const { data, error } = await helperClient
      .from('projects')
      .select('id')
      .eq('id', projectId);
    assert(!error, '5a: helper select (no error, just empty)', `rows=${data?.length}`, error?.message);
    assert(
      data?.length === 0,
      '5b: helper sees 0 rows (RLS blocks)',
      'helper cannot read project before joining',
      `expected 0 rows, got ${data?.length}`
    );
  }

  // -------------------------------------------------------------------------
  // Step 6 — RLS negative: helper cannot insert a project owned by creator
  // -------------------------------------------------------------------------
  {
    const { error } = await helperClient
      .from('projects')
      .insert({ title: 'rls violation attempt', owner_id: creatorId });
    assert(
      error !== null,
      '6: helper cannot insert project with creator owner_id (RLS)',
      `error code=${error?.code}`,
      'expected RLS error but insert succeeded'
    );
  }

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

  // -------------------------------------------------------------------------
  // Step 8 — RLS negative: helper cannot read invite rows
  // -------------------------------------------------------------------------
  {
    const { data, error } = await helperClient
      .from('invites')
      .select('id')
      .eq('project_id', projectId);
    assert(!error, '8a: helper invite select (no error)', `rows=${data?.length}`, error?.message);
    assert(
      data?.length === 0,
      '8b: helper sees 0 invite rows (owner-only RLS)',
      'helper cannot read invites',
      `expected 0 rows, got ${data?.length}`
    );
  }

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

  // -------------------------------------------------------------------------
  // Step 10 — Helper can now read the project; membership has 2 rows
  // -------------------------------------------------------------------------
  {
    const { data: pRows, error: pe } = await helperClient
      .from('projects')
      .select('id')
      .eq('id', projectId);
    assert(!pe && pRows?.length === 1, '10a: helper reads project after joining', `rows=${pRows?.length}`, pe?.message ?? `rows=${pRows?.length}`);

    const { data: mRows, error: me } = await helperClient
      .from('project_members')
      .select('user_id, role')
      .eq('project_id', projectId);
    assert(!me && mRows?.length === 2, '10b: project has 2 members after invite redemption', `rows=${mRows?.length}`, me?.message ?? `rows=${mRows?.length}`);
  }

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
  // Step 12 — Wrong code returns invalid_code. The sentinel cannot match the
  // 4-digit format, so it can never collide with a real active invite on the
  // shared database.
  // -------------------------------------------------------------------------
  {
    const { data, error } = await creatorClient.rpc('redeem_code', { p_code: 'XXXX' });
    assert(
      !error && data?.ok === false && data?.reason === 'invalid_code',
      '12: wrong code returns invalid_code',
      `reason=${data?.reason}`,
      error?.message ?? `unexpected data=${JSON.stringify(data)}`
    );
  }

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
      '13b: rogue email cannot sign in after blocked signup',
      `error=${signInErr?.message}`,
      'expected sign-in to fail but it succeeded'
    );

    // 13c: prove the blocked signup really created no auth.users row
    const { data: userList, error: listErr } = await adminClient.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    assert(
      !listErr && !userList.users.some((u) => u.email?.toLowerCase() === rogueEmail),
      '13c: no auth.users row exists for the rogue email',
      'rogue user absent from admin user list',
      listErr?.message ?? 'rogue user FOUND in admin user list'
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup() {
  console.log('\n--- cleanup ---');

  // Step C0: remove throwaway emails from the allowlist
  {
    const { error } = await adminClient
      .from('allowed_emails')
      .delete()
      .in('email', [creatorEmail, helperEmail]);
    if (error) console.error(`  WARN  cleanup: allowlist removal failed — ${error.message}`);
    else console.log('  OK    removed throwaway emails from allowlist');
  }

  // Step C1: Delete helper user first so invite.used_by FK exercises SET NULL
  if (helperId) {
    const { error } = await adminClient.auth.admin.deleteUser(helperId);
    if (error) {
      console.error(`  WARN  cleanup: delete helper user failed — ${error.message}`);
    } else {
      console.log(`  OK    deleted helper user ${helperId}`);
    }
  }

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

  // Step C3: Delete project as creator (cascades invites + project_members)
  if (projectId && creatorClient) {
    const { error } = await creatorClient
      .from('projects')
      .delete()
      .eq('id', projectId);
    if (error) {
      console.error(`  WARN  cleanup: delete project as creator — ${error.message}`);
      // Fallback: admin delete
      const { error: ae } = await adminClient.from('projects').delete().eq('id', projectId);
      if (ae) console.error(`  WARN  cleanup: admin delete project also failed — ${ae.message}`);
      else console.log(`  OK    deleted project (admin fallback) ${projectId}`);
    } else {
      console.log(`  OK    deleted project ${projectId} (cascades members + invites)`);
    }
  }

  // Step C4: Delete creator user
  if (creatorId) {
    const { error } = await adminClient.auth.admin.deleteUser(creatorId);
    if (error) {
      console.error(`  WARN  cleanup: delete creator user failed — ${error.message}`);
    } else {
      console.log(`  OK    deleted creator user ${creatorId}`);
    }
  }

  // Step C5: Confirm no test projects linger
  const { data: lingering, error: le } = await adminClient
    .from('projects')
    .select('id, title')
    .like('title', 'E2E smoke%');
  if (le) {
    console.error(`  WARN  cleanup: verification query failed — ${le.message}`);
  } else if (lingering?.length === 0) {
    console.log('  OK    no test projects remain in database');
  } else {
    console.error(`  WARN  ${lingering.length} test project(s) still present: ${JSON.stringify(lingering)}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  await runTests();
} catch (err) {
  // Non-assertion errors (unexpected throws)
  if (!results.some((r) => r.status === 'FAIL')) {
    fail('unexpected', err.message);
  }
  // Continue to cleanup
} finally {
  await cleanup();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== SUMMARY ===\n');
for (const r of results) {
  const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`  ${icon}  [${r.step}]${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`\n  ${results.filter((r) => r.status === 'PASS').length} passed, ${failureCount} failed.\n`);

process.exit(failureCount > 0 ? 1 : 0);
