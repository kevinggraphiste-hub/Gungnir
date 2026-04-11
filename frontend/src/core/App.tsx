/**
 * Gungnir — Main App Shell
 *
 * Core routes are always loaded. Plugin routes are lazy-loaded and wrapped in ErrorBoundary.
 */
import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import Sidebar from './components/Sidebar'
import { PluginErrorBoundary } from './components/ErrorBoundary'
import { useStore } from './stores/appStore'
import { api, apiFetch, clearAuthToken } from './services/api'
import { usePluginStore } from './stores/pluginStore'
import { useGlobalKeyboard } from './hooks/useKeyboard'
import { getPluginComponent } from './services/pluginLoader'

// ── Core pages (always bundled) ─────────────────────────────────────────────
import Chat from './pages/Chat'
import AgentSettings from './pages/AgentSettings'
import Settings from './pages/Settings'
import Login from './pages/Login'

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
function AppContent({ onLogout, showLogout }: { onLogout?: () => void; showLogout?: boolean }) {
  const setConfig = useStore((s) => s.setConfig)
  const setOnLogout = useStore((s) => s.setOnLogout)
  const loadPlugins = usePluginStore((s) => s.loadPlugins)
  const plugins = usePluginStore((s) => s.plugins)
  const pluginsLoaded = usePluginStore((s) => s.pluginsLoaded)

  // Register logout handler in store so Sidebar can access it
  useEffect(() => {
    if (showLogout && onLogout) setOnLogout(onLogout)
    return () => setOnLogout(null)
  }, [showLogout, onLogout])

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
          const allowedKeys = new Set(customVars)
          for (const [key, value] of Object.entries(colors)) {
            if (allowedKeys.has(key)) {
              document.documentElement.style.setProperty(key, value as string)
            }
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
        // Load core config + sync language
        // ⚠️ apiFetch (pas fetch brut) : quand l'auth est active, sans le
        // Bearer token /api/config renvoie 401 et toute la config (providers,
        // personnalités, etc.) apparaît vide dans l'UI.
        const configRes = await apiFetch('/api/config')
        if (configRes.ok) {
          const data = await configRes.json()
          setConfig(data)
          // Sync i18n language with backend config
          const savedLang = data?.app?.language
          if (savedLang) {
            const { default: i18n } = await import('../i18n')
            if (i18n.language !== savedLang) {
              i18n.changeLanguage(savedLang)
            }
          }
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
  const [authState, setAuthState] = useState<'checking' | 'logged_in' | 'needs_login' | 'no_auth'>('checking')

  useEffect(() => {
    const checkAuth = async () => {
      // checkAuth ne throw plus : il renvoie un objet explicite.
      const result = await api.checkAuth()
      if (result.ok) {
        setAuthState('logged_in')
      } else if (result.reason === 'needs_login') {
        setAuthState('needs_login')
      } else {
        // backend_error / network_error — backend pas prêt, on laisse passer
        setAuthState('no_auth')
      }
    }
    checkAuth()
  }, [])

  const handleLogin = () => {
    setAuthState('logged_in')
  }

  const handleLogout = () => {
    clearAuthToken()
    localStorage.removeItem('gungnir_current_user')
    setAuthState('needs_login')
  }

  if (authState === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent-primary)' }} />
      </div>
    )
  }

  if (authState === 'needs_login') {
    return <Login onLogin={handleLogin} />
  }

  // logged_in or no_auth — show the app
  return (
    <BrowserRouter>
      <AppContent onLogout={handleLogout} showLogout={authState === 'logged_in'} />
    </BrowserRouter>
  )
}
