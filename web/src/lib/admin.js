// Researcher admin layer (migration 0015). Every function here is READ-ONLY by
// construction: the admin's RLS grants cover SELECT alone, so even a bug that
// tried to write a participant's project would be refused by the database.
//
// Participant emails are not reachable through any table policy (they live in
// auth.users), so the dashboard gets them from the security-definer RPCs, each
// of which re-checks is_app_admin() server-side. The client's `isAdmin` flag is
// a UI convenience only — it grants nothing.

// Whether the signed-in account is a researcher admin. Any failure (RPC
// missing because the migration has not been pushed yet, network blip, plain
// non-admin) resolves to false, so a participant never sees an admin affordance
// because of an error.
export async function fetchIsAdmin(supabase) {
  try {
    const { data, error } = await supabase.rpc('is_app_admin')
    if (error) return false
    return data === true
  } catch {
    return false
  }
}

// One row per project across the whole trial, already rolled up and ordered by
// last activity (newest first) by admin_list_projects().
export async function fetchAdminProjects(supabase) {
  const { data, error } = await supabase.rpc('admin_list_projects')
  if (error) throw new Error(error.message)
  return data ?? []
}

// user_id -> email for the ids already visible to the admin (uploaders, task
// authors, whoever last saved the timeline). Returns a Map; unknown ids are
// simply absent so callers can fall back to a truncated id.
export async function fetchUserEmails(supabase, userIds) {
  const ids = [...new Set((userIds ?? []).filter(Boolean))]
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase.rpc('admin_user_emails', { p_user_ids: ids })
  if (error) throw new Error(error.message)
  return new Map((data ?? []).map((row) => [row.user_id, row.email]))
}

// Per-project interaction-log roll-up: [{ event_type, event_count, last_at }].
export async function fetchProjectEvents(supabase, projectId) {
  const { data, error } = await supabase.rpc('admin_project_events', { p_project_id: projectId })
  if (error) throw new Error(error.message)
  return data ?? []
}

// --- pure helpers -----------------------------------------------------------

// "Where is this pair right now?" — one glanceable state per project, derived
// only from the roll-up columns. Ordered by urgency: a failed video is the one
// thing that needs the researcher, so it outranks everything else even if the
// pair has since carried on editing.
export function projectStage(row) {
  if (!row) return { key: 'unknown', label: 'Unknown' }
  if ((row.videos_failed ?? 0) > 0) return { key: 'failed', label: 'Video failed' }
  if ((row.video_count ?? 0) === 0) return { key: 'empty', label: 'No video yet' }
  if ((row.videos_processing ?? 0) > 0) return { key: 'processing', label: 'Processing' }
  if ((row.videos_ready ?? 0) === 0) return { key: 'empty', label: 'No video ready' }
  if ((row.render_count ?? 0) > 0) return { key: 'exported', label: 'Exported' }
  if ((row.state_version ?? 0) > 1) return { key: 'editing', label: 'Editing' }
  return { key: 'ready', label: 'Not edited yet' }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Coarse, non-ticking relative time for the "last seen" column. Deliberately
// low-resolution: the researcher cares about "today vs three days ago", and a
// coarse string means the dashboard does not need a re-render timer.
export function timeAgo(iso, now = Date.now()) {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const delta = now - then
  if (delta < 0) return 'just now'
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) {
    const m = Math.floor(delta / MINUTE)
    return `${m} min ago`
  }
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR)
    return h === 1 ? '1 hour ago' : `${h} hours ago`
  }
  const d = Math.floor(delta / DAY)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

// Members arrive as jsonb from admin_list_projects. Creator first, then helpers,
// so the pair always reads in the same order down the dashboard.
export function orderMembers(members) {
  const list = Array.isArray(members) ? members : []
  const rank = (m) => (m?.role === 'creator' ? 0 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b) || String(a?.email).localeCompare(String(b?.email)))
}

export function formatDuration(seconds) {
  // A video that has not finished processing has a null duration; Number(null)
  // is 0, which would print a confident "0:00" for an unknown length.
  if (seconds === null || seconds === undefined || seconds === '') return '—'
  const total = Number(seconds)
  if (!Number.isFinite(total) || total < 0) return '—'
  const mins = Math.floor(total / 60)
  const secs = Math.round(total % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
