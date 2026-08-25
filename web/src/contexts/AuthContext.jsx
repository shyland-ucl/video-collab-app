import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { fetchIsAdmin } from '../lib/admin'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // undefined = still loading, null = signed out, object = session
  const [session, setSession] = useState(undefined)
  // undefined = not resolved yet, boolean = answer from is_app_admin()
  const [isAdmin, setIsAdmin] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // The admin check is a UI convenience: it decides whether to OFFER the
  // researcher views. Every admin read is re-authorised in the database
  // (is_app_admin() inside each policy and RPC), so a client that forced this
  // to true would still see nothing.
  //
  // Keyed on the user id, NOT the session object: onAuthStateChange hands out a
  // fresh session on every hourly token refresh, and depending on it would
  // re-run the RPC and blink isAdmin back to undefined each time — which
  // RequireAdmin would render as a loading screen mid-session.
  const sessionLoading = session === undefined
  const userId = session?.user?.id ?? null
  useEffect(() => {
    if (sessionLoading) return
    if (!userId) {
      setIsAdmin(false)
      return
    }
    let cancelled = false
    setIsAdmin(undefined)
    fetchIsAdmin(supabase).then((result) => {
      if (!cancelled) setIsAdmin(result)
    })
    return () => {
      cancelled = true
    }
  }, [sessionLoading, userId])

  const signOut = () => supabase.auth.signOut()

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, isAdmin, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
