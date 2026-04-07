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
import { api } from './services/api'
import { usePluginStore } from './stores/pluginStore'
import { useGlobalKeyboard } from './hooks/useKeyboard'
import { getPluginComponent } from './services/pluginLoader'

// ── Core pages (always bundled) ─────────────────────────────────────────────
import Chat from './pages/Chat'
import AgentSettings from './pages/AgentSettings'
import Settings from './pages/Settings'

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
  const pluginsLoaded = usePluginStore((s) => s.pluginsLoaded)

  // Global keyboard shortcuts
  useGlobalKeyboard()

  // Apply saved theme & font size on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('gungnir_theme')
    if (savedTheme) {
      // Toujours nettoyer les CSS custom inline d'abord
      const customVars = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--accent-primary', '--accent-secondary', '--text-primary', '--text-secondary', '--text-muted', '--border']
      customVars.forEach(v => document.documentElement.style.removeProperty(v))
      document.documentElement.setAttribute('data-theme', savedTheme)
      if (savedTheme === 'custom') {
        try {
          const colors = JSON.parse(localStorage.getItem('gungnir_custom_theme') || '{}')
          for (const [key, value] of Object.entries(colors)) {
            document.documentElement.style.setProperty(key, value as string)
          }
        } catch { /* ignore */ }
      }
    }
    const savedSize = localStorage.getItem('gungnir_fontsize')
    if (savedSize) document.documentElement.setAttribute('data-fontsize', savedSize)
  }, [])

  // Load config + plugins on mount
  useEffect(() => {
    const init = async () => {
      try {
        // Load core config
        const configRes = await fetch('/api/config')
        if (configRes.ok) {
          const data = await configRes.json()
          setConfig(data)
        }

        // Load conversations (filtered by current user if logged in)
        try {
          const savedUser = localStorage.getItem('gungnir_current_user')
          const userId = savedUser ? JSON.parse(savedUser)?.id : undefined
          const convos = await api.getConversations(userId)
          useStore.getState().setConversations(convos)
        } catch { /* backend may not be ready yet */ }

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
            <Route path="/" element={<Chat />} />
            <Route path="/agent" element={<AgentSettings />} />
            <Route path="/settings" element={<Settings />} />

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

            {pluginsLoaded && <Route path="*" element={<Navigate to="/" />} />}
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
