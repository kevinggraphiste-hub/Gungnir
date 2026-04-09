/**
 * Gungnir — Plugin ErrorBoundary
 *
 * Wraps each plugin so a crash in one plugin doesn't take down the whole app.
 */
import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  pluginName: string
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class PluginErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[Plugin ${this.props.pluginName}] Crash:`, error, info)
  }

  handleRetry = () => {
    // If it's a chunk loading error (stale hash after deploy), hard reload to get fresh assets
    const msg = this.state.error?.message || ''
    if (msg.includes('dynamically imported module') || msg.includes('Failed to fetch') || msg.includes('Loading chunk')) {
      window.location.reload()
      return
    }
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div
            className="max-w-md w-full rounded-xl p-6 text-center space-y-4"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
            }}
          >
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
              style={{ background: 'color-mix(in srgb, var(--accent-danger) 15%, transparent)' }}
            >
              <AlertTriangle className="w-6 h-6" style={{ color: 'var(--accent-danger)' }} />
            </div>

            <div>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                Plugin "{this.props.pluginName}" — erreur
              </h3>
              <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                Ce plugin a rencontre un probleme. Le reste de l'application fonctionne normalement.
              </p>
            </div>

            {this.state.error && (
              <pre
                className="text-xs text-left p-3 rounded-lg overflow-auto max-h-32"
                style={{
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-secondary)',
                }}
              >
                {this.state.error.message}
              </pre>
            )}

            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: 'var(--accent-primary)',
                color: 'white',
              }}
            >
              <RefreshCw className="w-4 h-4" />
              Reessayer
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
