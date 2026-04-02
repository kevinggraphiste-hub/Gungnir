/**
 * Gungnir — Main App Shell
 *
 * Core routes are always loaded. Plugin routes are lazy-loaded and wrapped in ErrorBoundary.
 */
import { Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import Sidebar from './components/Sidebar'
import { PluginErrorBoundary } from './components/ErrorBoundary'
import { useStore } from './stores/appStore'
import { usePluginStore } from './stores/pluginStore'
import { useGlobalKeyboard } from './hooks/useKeyboard'
import { getPluginComponent } from './services/pluginLoader'

// ── Core pages (always bundled) ─────────────────────────────────────────────
// These will be created in Phase 2 when we migrate Chat, Agent, Settings
// For now, placeholder components
function ChatPlaceholder() {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
      <p>Chat — Phase 2</p>
    </div>
  )
}

function AgentPlaceholder() {
  return (
    <div className="flex-1 flex items-center justify-center p-6" style={{ color: 'var(--text-muted)' }}>
      <p>Agent Settings — Phase 2</p>
    </div>
  )
}

function SettingsPlaceholder() {
  return (
    <div className="flex-1 flex items-center justify-center p-6" style={{ color: 'var(--text-muted)' }}>
      <p>Settings — Phase 2</p>
    </div>
  )
}

// ── Loading fallback ────────────────────────────────────────────────────────
function PluginLoading() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} />
    </div>
  )
}

// ── Plugin route renderer ───────────────────────────────────────────────────
function PluginPage({ name }: { name: string }) {
  const Component = getPluginComponent(name)
  if (!Component) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
        Plugin "{name}" non trouve
      </div>
    )
  }
  return <Component />
}

// ── App content ─────────────────────────────────────────────────────────────
function AppContent() {
  const setConfig = useStore((s) => s.setConfig)
  const loadPlugins = usePluginStore((s) => s.loadPlugins)
  const plugins = usePluginStore((s) => s.plugins)

  // Global keyboard shortcuts
  useGlobalKeyboard()

  // Apply saved theme & font size on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('gungnir_theme')
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme)
    const savedSize = localStorage.getItem('gungnir_fontsize')
    if (savedSize) document.documentElement.setAttribute('data-fontsize', savedSize)
  }, [])

  // Load config + plugins on mount
  useEffect(() => {
    const init = async () => {
      try {
        // Load core config
        const configRes = await fetch('/api/health')
        if (configRes.ok) {
          const data = await configRes.json()
          setConfig(data)
        }

        // Load plugins
        await loadPlugins()
      } catch (err) {
        console.error('Init error:', err)
      }
    }
    init()
  }, [])

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--bg-primary)' }}>
      <Sidebar />
      <main className="flex-1 h-screen overflow-hidden flex flex-col">
        <Suspense fallback={<PluginLoading />}>
          <Routes>
            {/* Core routes — always present */}
            <Route path="/" element={<ChatPlaceholder />} />
            <Route path="/agent" element={<AgentPlaceholder />} />
            <Route path="/settings" element={<SettingsPlaceholder />} />

            {/* Plugin routes — dynamic, lazy-loaded, error-isolated */}
            {plugins
              .filter((p) => p.enabled)
              .map((plugin) => (
                <Route
                  key={plugin.name}
                  path={plugin.route}
                  element={
                    <PluginErrorBoundary pluginName={plugin.display_name}>
                      <PluginPage name={plugin.name} />
                    </PluginErrorBoundary>
                  }
                />
              ))}

            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  )
}
