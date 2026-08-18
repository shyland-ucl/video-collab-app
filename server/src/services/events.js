// Server-side twin of web/src/lib/events.js (trial design 2026-08-18).
// Writes with the service role (bypasses RLS) for events only the server can
// see: processing outcomes, AI proposals, renders, VQA. Same contract as the
// client logger: fire-and-forget — a lost log row must never fail or slow a
// route, so callers do NOT await this and every failure is swallowed after a
// console.warn (visible in Railway logs).
export async function logServerEvent(supabase, { userId = null, projectId = null, type, payload = {} }) {
  try {
    const { error } = await supabase.from('events').insert({
      user_id: userId,
      project_id: projectId,
      event_type: type,
      payload,
    })
    if (error) console.warn(`event log failed (${type}): ${error.message}`)
  } catch (err) {
    console.warn(`event log failed (${type}): ${String(err?.message ?? err)}`)
  }
}
