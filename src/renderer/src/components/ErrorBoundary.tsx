import { Component, type ReactNode } from 'react'

/**
 * Catches a screen that crashed, so the window never goes blank. Saved
 * writing isn't touched; "Try again" draws the screen afresh, "Reload"
 * restarts the window (everything is saved as it's typed).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; attempt: number }
> {
  override state = { error: null as Error | null, attempt: 0 }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Screen crashed:', error, info.componentStack)
  }

  override render() {
    const { error, attempt } = this.state
    if (!error)
      return (
        <div key={attempt} className="error-boundary-ok">
          {this.props.children}
        </div>
      )
    return (
      <div className="page-message crash-message" role="alert">
        <h2>Something went wrong on this screen</h2>
        <p className="muted">
          Your writing is safe: it was saved as you typed. You can try again, or reload the window.
        </p>
        <div className="row">
          <button
            className="primary"
            onClick={() => this.setState({ error: null, attempt: attempt + 1 })}
          >
            Try again
          </button>
          <button onClick={() => window.location.reload()}>Reload the window</button>
        </div>
        <details className="small muted">
          <summary>What happened</summary>
          <pre>{`${error.message}\n${error.stack ?? ''}`.slice(0, 4000)}</pre>
        </details>
      </div>
    )
  }
}
