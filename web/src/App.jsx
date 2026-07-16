import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { AccessibilityProvider } from './contexts/AccessibilityContext'
import ErrorBoundary from './components/ErrorBoundary'
import PageLoader from './components/PageLoader'
import RequireAuth from './components/RequireAuth'
import RouteAccessibility from './components/RouteAccessibility'
import SignInPage from './pages/SignInPage'
import ProjectsPage from './pages/ProjectsPage'
import NotFoundPage from './pages/NotFoundPage'

// Keep the sign-in/home path small. Project detail pulls in the resumable
// uploader, while the editor owns most interaction code, so both are loaded
// only when a member navigates to them.
const ProjectPage = lazy(() => import('./pages/ProjectPage'))
const VideoPage = lazy(() => import('./pages/VideoPage'))
const EditorPage = lazy(() => import('./pages/EditorPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

export default function App() {
  return (
    <AuthProvider>
      <AccessibilityProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-field focus:border focus:border-brand focus:bg-surface focus:p-3 focus:font-semibold focus:text-ink focus:shadow-pop"
      >
        Skip to content
      </a>
      {/* ErrorBoundary sits INSIDE the provider tree and around the routes so a
          page render crash speaks + shows a recoverable alert instead of a
          silent white screen, while the announcer live regions below stay
          mounted for its assertive announce(). */}
      <ErrorBoundary>
        <RouteAccessibility />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
            <Route path="/projects/:id" element={<RequireAuth><ProjectPage /></RequireAuth>} />
            <Route path="/projects/:projectId/videos/:videoId" element={<RequireAuth><VideoPage /></RequireAuth>} />
            <Route path="/projects/:projectId/edit" element={<RequireAuth><EditorPage /></RequireAuth>} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      {/* Live announcers use aria-live ONLY (no role="status"/"alert"): an
          explicit role makes VoiceOver speak the role name ("status"/"alert")
          after every message. aria-live drives the announcement identically
          without that trailing chatter. */}
      <div id="sr-announcer" aria-live="polite" aria-atomic="true" className="sr-only" />
      <div id="sr-announcer-assertive" aria-live="assertive" aria-atomic="true" className="sr-only" />
      </AccessibilityProvider>
    </AuthProvider>
  )
}
