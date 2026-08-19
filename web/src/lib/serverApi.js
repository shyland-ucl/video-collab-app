import { supabase } from './supabaseClient'

export async function serverPost(pathname, body) {
  const base = import.meta.env.VITE_SERVER_URL
  if (!base) throw new Error('server_not_configured')

  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('not_signed_in')

  let res
  try {
    res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // fetch itself rejected: server down / network gone — distinguishable
    // from an HTTP error so trial logs and messages can tell them apart.
    throw new Error('server_unreachable')
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error ?? ''
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `server_error_${res.status}`)
  }
  return res.status === 204 ? null : res.json()
}
