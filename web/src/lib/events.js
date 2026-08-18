import { supabase } from './supabaseClient'

// Trial interaction log (design 2026-08-18) — the client half; the server
// half is server/src/services/events.js. Fire-and-forget by contract:
// logging must never block, slow, or break the UI, so this returns nothing
// and swallows every failure (the trial loses a row, the participant loses
// nothing). RLS allows insert-only of the participant's own events.
export function logEvent(eventType, payload = {}, projectId = null) {
  try {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        const userId = data?.session?.user?.id
        if (!userId) return null
        return supabase.from('events').insert({
          user_id: userId,
          project_id: projectId,
          event_type: eventType,
          payload,
        })
      })
      .then(
        () => {},
        () => {},
      )
  } catch {
    /* never throws */
  }
}
