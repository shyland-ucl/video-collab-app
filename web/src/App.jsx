import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { AccessibilityProvider } from './contexts/AccessibilityContext'
import RequireAuth from './components/RequireAuth'
import SignInPage from './pages/SignInPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectPage from './pages/ProjectPage'
import VideoPage from './pages/VideoPage'
import EditorPage from './pages/EditorPage'
import SettingsPage from './pages/SettingsPage'

export default function App() {
  return (
    <AuthProvider>
      <AccessibilityProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-white focus:p-2"
      >
        Skip to content
      </a>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        <Route path="/projects/:id" element={<RequireAuth><ProjectPage /></RequireAuth>} />
        <Route path="/projects/:projectId/videos/:videoId" element={<RequireAuth><VideoPage /></RequireAuth>} />
        <Route path="/projects/:projectId/edit" element={<RequireAuth><EditorPage /></RequireAuth>} />
      </Routes>
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
