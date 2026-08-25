import { Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import PageLoader from './PageLoader'

// Gate for the researcher views. Cosmetic only — it stops a mistyped /admin URL
// from rendering an empty dashboard; the actual authorisation is is_app_admin()
// inside every policy and RPC the pages behind it call.
export default function RequireAdmin({ children }) {
  const { isAdmin } = useAuth()

  if (isAdmin === undefined) return <PageLoader label="Checking your access…" />
  if (!isAdmin) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1 className="page-title mb-3">Not available</h1>
        <p className="muted mb-4">This area is for the study researcher.</p>
        <Link to="/" className="link-back">
          <span aria-hidden="true">←</span> Back to your projects
        </Link>
      </main>
    )
  }
  return children
}
