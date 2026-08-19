// Trial failure notice (design 2026-08-18). Shown when the STUDY SYSTEM
// itself is broken (Supabase paused, server unreachable, page crash) — never
// for ordinary user-fixable errors like a wrong password. Participants in the
// unsupervised field trial must know the problem is not their fault and who
// fixes it, instead of hitting a dead generic error.
const CONTACT = 'l.xiao.22@ucl.ac.uk'

export default function StudyErrorNotice() {
  return (
    <p className="mt-3 rounded-field border border-helper/50 bg-helper-soft p-3 text-sm text-ink">
      The study system is having a problem — this is not your fault.{' '}
      <a className="link" href={`mailto:${CONTACT}?subject=Video%20study%20problem`}>
        Email Lan
      </a>{' '}
      so it can be fixed.
    </p>
  )
}
