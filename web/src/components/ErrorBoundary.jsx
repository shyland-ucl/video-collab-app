import { Component } from 'react'
import { announce } from '../utils/announcer'

const FALLBACK_TEXT = 'Something went wrong. Try reloading the page.'

/**
 * App-level error boundary. A React render crash is otherwise a blank white
 * screen with no feedback — for a blind or low-vision creator that is
 * unrecoverable. This catches the crash, speaks it assertively, and renders a
 * recoverable alert. Placed INSIDE App (around <Routes>) so the global
 * announcer live regions stay mounted for the announce() call.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    announce(FALLBACK_TEXT, { assertive: true })
    console.error('ErrorBoundary caught:', error, info?.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
        <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-700">
          {FALLBACK_TEXT}
        </p>
        <a href="/" className="mt-3 inline-block underline">
          Go back to your projects
        </a>
      </main>
    )
  }
}
