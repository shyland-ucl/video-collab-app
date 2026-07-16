export default function PageLoader({ label = 'Loading page…' }) {
  return (
    <div className="mx-auto flex min-h-[50dvh] w-full max-w-lg items-center justify-center px-5">
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="rounded-field border border-line bg-surface px-4 py-3 font-semibold text-ink-soft shadow-card"
      >
        {label}
      </p>
    </div>
  )
}
