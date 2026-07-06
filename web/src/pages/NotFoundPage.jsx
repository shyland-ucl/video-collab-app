import { Link } from 'react-router-dom'

/**
 * Catch-all route for unknown URLs. Semantic heading + a clear way back, so a
 * mistyped or stale link lands somewhere navigable rather than a blank screen.
 */
export default function NotFoundPage() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
      <h1 className="text-xl font-bold">Page not found</h1>
      <p role="status" className="mt-2">That page doesn't exist or has moved.</p>
      <Link to="/" className="mt-3 inline-block underline">
        Back to your projects
      </Link>
    </main>
  )
}
