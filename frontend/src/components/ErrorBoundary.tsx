import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', padding: 'var(--space-6)', textAlign: 'center', color: 'var(--text)',
          background: 'var(--bg)',
        }}>
          <div style={{ fontSize: 'var(--font-size-title)', marginBottom: 'var(--space-4)' }}>
            Something went wrong
          </div>
          <code style={{
            fontSize: 'var(--font-size-small)', color: 'var(--reject)',
            background: 'var(--surface)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)',
            maxWidth: 600, overflow: 'auto', marginBottom: 'var(--space-4)',
          }}>
            {this.state.error?.message}
          </code>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: 'var(--space-2) var(--space-4)', background: 'var(--accent)',
              color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
