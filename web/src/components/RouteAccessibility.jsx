import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { logEvent } from '../lib/events'

const APP_NAME = 'Video Collab'

export function titleForPath(pathname) {
  if (pathname === '/') return 'Projects'
  if (pathname === '/signin') return 'Sign in'
  if (pathname === '/settings') return 'Settings'
  if (/^\/projects\/[^/]+\/edit$/.test(pathname)) return 'Editor'
  if (/^\/projects\/[^/]+\/videos\/[^/]+$/.test(pathname)) return 'Video details'
  if (/^\/projects\/[^/]+$/.test(pathname)) return 'Project'
  return 'Page not found'
}

export default function RouteAccessibility() {
  const { pathname } = useLocation()
  const previousPathRef = useRef(pathname)

  useEffect(() => {
    document.title = `${titleForPath(pathname)} | ${APP_NAME}`
    // Trial log: page NAME only (titleForPath), never raw ids in the payload —
    // the ids that matter are joined back in from context at export time.
    logEvent('page_view', { page: titleForPath(pathname) })
  }, [pathname])

  useEffect(() => {
    const routeChanged = previousPathRef.current !== pathname
    previousPathRef.current = pathname
    if (!routeChanged) return undefined

    const focusMain = () => {
      const main = document.getElementById('main')
      if (!main) return false
      try {
        main.focus({ preventScroll: true })
      } catch {
        main.focus()
      }
      return true
    }

    if (focusMain()) return undefined

    // A lazy route briefly renders the loading fallback without a <main>.
    // Keep watching until the real page mounts, then move focus exactly once.
    const root = document.getElementById('root')
    if (!root || typeof MutationObserver === 'undefined') return undefined
    const observer = new MutationObserver(() => {
      if (focusMain()) observer.disconnect()
    })
    observer.observe(root, { childList: true, subtree: true })
    const timeout = setTimeout(() => observer.disconnect(), 5000)
    return () => {
      clearTimeout(timeout)
      observer.disconnect()
    }
  }, [pathname])

  return null
}
