import { Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import RequireAuth from './components/RequireAuth'
import SignInPage from './pages/SignInPage'

function Placeholder({ name }) {
  return <main id="main" tabIndex={-1} className="p-4">{name}</main>
}

export default function App() {
  return (
    <AuthProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-white focus:p-2"
      >
        Skip to content
      </a>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/" element={<RequireAuth><Placeholder name="projects" /></RequireAuth>} />
        <Route path="/projects/:id" element={<RequireAuth><Placeholder name="project" /></RequireAuth>} />
        <Route path="/join/:token" element={<Placeholder name="join" />} />
      </Routes>
      <div id="sr-announcer" role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
      <div id="sr-announcer-assertive" role="alert" aria-live="assertive" aria-atomic="true" className="sr-only" />
    </AuthProvider>
  )
}
