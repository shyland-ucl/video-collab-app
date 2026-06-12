import { supabase } from './supabaseClient'

export async function serverPost(pathname, body) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new Error('not_signed_in')

  const res = await fetch(`${import.meta.env.VITE_SERVER_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

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
