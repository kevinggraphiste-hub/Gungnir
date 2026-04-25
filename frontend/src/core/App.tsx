/**
 * Gungnir — Main App Shell
 *
 * Core routes are always loaded. Plugin routes are lazy-loaded and wrapped in ErrorBoundary.
 */
import { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import Sidebar from './components/Sidebar'
import CommandPalette from './components/CommandPalette'
import { PluginErrorBoundary } from './components/ErrorBoundary'
import { useStore } from './stores/appStore'
import { api, apiFetch, clearAuthToken } from './services/api'
import { usePluginStore } from './stores/pluginStore'
import { useGlobalKeyboard } from './hooks/useKeyboard'
import { useUIPreferences } from './hooks/useUIPreferences'
import { getPluginComponent } from './services/pluginLoader'

// ── Core pages (always bundled) ─────────────────────────────────────────────
import Chat from './pages/Chat'
import AgentSettings from './pages/AgentSettings'
import Settings from './pages/Settings'
import Login from './pages/Login'
import { SpearCodeContent } from '../plugins/code/index'

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

  // Command palette (Ctrl+K / Cmd+K — jumps to any page, tab, skill, action)
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Register logout handler in store so Sidebar can access it
  useEffect(() => {
    if (showLogout && onLogout) setOnLogout(onLogout)
    return () => setOnLogout(null)
  }, [showLogout, onLogout])

  // Global keyboard shortcuts
  useGlobalKeyboard()

  // Charge et applique les préférences typographie / accessibilité (persistées par user)
  useUIPreferences()

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
    // La taille de police est désormais gérée par useUIPreferences (persisté par user)
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
          // Sync i18n language with per-user config (fallback to localStorage)
          const savedLang = data?.language || localStorage.getItem('gungnir_language')
          if (savedLang) {
            const { default: i18n } = await import('../i18n')
            if (i18n.language !== savedLang) {
              i18n.changeLanguage(savedLang)
            }
          }
        }

        // Load per-user app preferences (agent_name, active provider/model)
        // so the Settings page and chat.py agree on the current user's
        // identity. Without this, the input in Settings would only reflect
        // localStorage which may be stale or empty after a login.
        // We hydrate the store directly (not via setAgentName) to avoid a
        // POST-back loop that would overwrite the value we just fetched.
        try {
          const appRes = await apiFetch('/api/config/user/app')
          if (appRes.ok) {
            const appData = await appRes.json()
            if (appData?.agent_name) {
              localStorage.setItem('gungnir_agent_name', appData.agent_name)
              useStore.setState({ agentName: appData.agent_name })
            }
            if (appData?.active_provider) {
              localStorage.setItem('gungnir_provider', appData.active_provider)
              useStore.setState({ selectedProvider: appData.active_provider })
            }
            if (appData?.active_model) {
              localStorage.setItem('gungnir_model', appData.active_model)
              useStore.setState({ selectedModel: appData.active_model })
            }
          }
        } catch { /* backend may not be ready yet */ }

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
      <Routes>
        {/* Mode "frame standalone" : sert SpearCode sans sidebar/layout — utilisé
            via iframe par la route `/code` du plugin pour isoler ses side-effects
            (WebSocket LSP, listeners globaux) du reste de l'app. */}
        <Route path="/code-frame" element={
          <main className="flex-1 h-screen overflow-hidden flex flex-col" style={{ width: '100vw' }}>
            <PluginErrorBoundary pluginName="SpearCode">
              <SpearCodeContent />
            </PluginErrorBoundary>
          </main>
        } />
        {/* Mode normal : sidebar + main avec routes plugin classiques. */}
        <Route path="*" element={
          <>
            <Sidebar />
            <main className="flex-1 h-screen overflow-hidden flex flex-col">
              <RoutesShell plugins={plugins} pluginsLoaded={pluginsLoaded} />
            </main>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
          </>
        } />
      </Routes>
    </div>
  )
}

// `key={pathname}` sur Suspense force React à démonter intégralement l'arbre
// précédent à chaque changement de route. Sans ça, des side-effects persistants
// (WebSocket LSP de CodeMirror dans SpearCode, listeners globaux non cleanés,
// etc.) peuvent empêcher l'affichage du nouveau plugin alors que l'URL a déjà
// changé — symptôme observé : URL change, contenu reste sur le plugin précédent.
function RoutesShell({ plugins, pluginsLoaded }: { plugins: any[]; pluginsLoaded: boolean }) {
  const location = useLocation()
  return (
    <Suspense key={location.pathname} fallback={<PluginLoading />}>
      <Routes>
        {/* Core routes — always present, wrapped in ErrorBoundary to prevent blank page crashes */}
        <Route path="/" element={<PluginErrorBoundary pluginName="Chat"><Chat /></PluginErrorBoundary>} />
        <Route path="/agent" element={<PluginErrorBoundary pluginName="Agent"><AgentSettings /></PluginErrorBoundary>} />
        <Route path="/settings" element={<PluginErrorBoundary pluginName="Paramètres"><Settings /></PluginErrorBoundary>} />

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
    // Clean all user-specific data to prevent bleeding between accounts
    const userKeys = [
      'gungnir_current_user', 'gungnir_favorite_models', 'gungnir_chat_sidebar',
      'gungnir_titles_generated', 'gungnir_provider', 'gungnir_model',
      'gungnir_agent_name', 'gungnir_theme', 'gungnir_fontsize', 'gungnir_custom_theme', 'gungnir_ui_prefs',
    ]
    userKeys.forEach(k => localStorage.removeItem(k))
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
