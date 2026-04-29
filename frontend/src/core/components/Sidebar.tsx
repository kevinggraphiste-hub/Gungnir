/**
 * Gungnir — Dynamic Sidebar
 *
 * Core nav items are hardcoded. Plugin items are injected from pluginStore.
 * Supports collapse via Ctrl+Shift+B.
 */
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  MessageSquare, Bot, Settings2, ChevronLeft, ChevronRight,
  Globe, Mic, BarChart3, Calendar, Plug, Webhook, BookOpen, Code, RadioTower, Brain,
  LayoutGrid, Hammer, Workflow,
  LogOut, X,
} from 'lucide-react'
import { useSidebarStore } from '../stores/sidebarStore'
import { usePluginStore, PluginManifest } from '../stores/pluginStore'
import { useStore } from '../stores/appStore'
import { useBreakpoint } from '../hooks/useBreakpoint'

// Map icon names from manifests to Lucide components
const ICON_MAP: Record<string, any> = {
  Globe, Mic, BarChart3, Calendar, Plug, Webhook, BookOpen, Code,
  MessageSquare, Bot, Settings2, RadioTower, Brain, LayoutGrid,
  Hammer, Workflow,
}

export default function Sidebar() {
  const { t } = useTranslation()
  const collapsed = useSidebarStore((s) => s.collapsed)
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed)
  const mobileOpen = useSidebarStore((s) => s.mobileOpen)
  const setMobileOpen = useSidebarStore((s) => s.setMobileOpen)
  const plugins = usePluginStore((s) => s.plugins)
  const onLogout = useStore((s) => s.onLogout)
  const breakpoint = useBreakpoint()
  const isMobile = breakpoint === 'mobile'

  // En mobile, la sidebar n'est jamais "collapsed icons-only" — c'est soit
  // ouverte plein-écran, soit complètement cachée (drawer).
  const showLabels = isMobile ? mobileOpen : !collapsed
  // Largeur :
  //   mobile fermé   → 0 (translateX hors écran)
  //   mobile ouvert  → 280 (drawer plein label, plus large pour le doigt)
  //   desktop        → 64 ou 200 selon collapsed
  const widthPx = isMobile ? 280 : (collapsed ? 64 : 200)

  // Items core hardcodés — toujours en tête de la section PLUGINS
  type NavItem = { path: string; icon: any; label: string; version?: string }
  const CORE_ITEMS: NavItem[] = [
    { path: '/', icon: MessageSquare, label: t('nav.chat') },
    { path: '/agent', icon: Bot, label: t('nav.agent') },
  ]

  // Plugins activés, triés par sidebar_position
  const enabledPlugins = plugins
    .filter((p) => p.enabled)
    .sort((a, b) => a.sidebar_position - b.sidebar_position)

  const toItem = (p: PluginManifest) => ({
    path: p.route,
    icon: ICON_MAP[p.icon] || Globe,
    label: p.display_name,
    version: p.version,
  })

  // Ces plugins atterrissent en bas dans la section SYSTÈME (guide de modèles,
  // analytics) — le reste (HuntR, Voice, Conscience, Code, Scheduler, Channels,
  // Webhooks, …) va dans la grande section PLUGINS.
  const SYSTEM_PLUGINS = new Set(['model_guide', 'analytics'])

  const pluginItems = enabledPlugins
    .filter((p) => !SYSTEM_PLUGINS.has(p.name))
    .map(toItem)

  const systemPlugins = enabledPlugins
    .filter((p) => SYSTEM_PLUGINS.has(p.name))
    .map(toItem)

  const pluginsList = [...CORE_ITEMS, ...pluginItems]
  const systemList = [...systemPlugins, { path: '/settings', icon: Settings2, label: t('nav.settings') }]

  // Ferme le drawer mobile dès qu'on clique sur un lien — sinon il reste
  // ouvert par-dessus la nouvelle page, pénible.
  const closeOnNav = () => { if (isMobile) setMobileOpen(false) }

  return (
    <>
      {/* Backdrop mobile : assombrit le contenu derrière le drawer + click-to-close */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={
          isMobile
            ? `fixed inset-y-0 left-0 z-50 flex flex-col border-r transition-transform duration-300 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`
            : 'relative h-screen flex flex-col border-r transition-all duration-300'
        }
        style={{
          width: `${widthPx}px`,
          height: isMobile ? '100dvh' : '100vh',
          background: 'var(--bg-primary)',
          borderColor: 'var(--border-subtle)',
        }}
      >
      {/* Logo + Agent name + close-button mobile */}
      <div
        className="px-3 py-4 border-b flex items-center gap-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <img src="/logo.png" alt="Gungnir" className="w-8 h-8 rounded-full object-contain" />
        {showLabels && (
          <span className="font-bold text-sm tracking-wide gradient-text">
            Gungnir
          </span>
        )}
        {isMobile && mobileOpen && (
          <button
            onClick={() => setMobileOpen(false)}
            className="ml-auto rounded-lg flex items-center justify-center"
            style={{ width: 44, height: 44, color: 'var(--text-secondary)' }}
            aria-label="Fermer le menu"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Navigation — PLUGINS puis SYSTÈME à la suite */}
      <nav className="flex-1 p-2 overflow-y-auto">
        {/* Section PLUGINS — compteur total à droite du titre */}
        <div>
          {showLabels ? (
            <div
              className="px-2 pb-1 flex items-center justify-between text-[9px] font-bold uppercase tracking-[0.18em]"
              style={{ color: 'var(--text-muted)', opacity: 0.75 }}
            >
              <span>Plugins</span>
              <span style={{ opacity: 0.7 }}>/ {pluginsList.length}</span>
            </div>
          ) : null}
          <div className="space-y-0.5">
            {pluginsList.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className="nav-item"
                title={item.label}
                onClick={closeOnNav}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {showLabels && (
                  <span className="text-[13px] font-medium">{item.label}</span>
                )}
              </NavLink>
            ))}
          </div>
        </div>

        {/* Section SYSTÈME — Modèles / Analytics / Settings, à la suite de PLUGINS */}
        <div className="mt-4">
          {showLabels ? (
            <div
              className="px-2 pb-1 text-[9px] font-bold uppercase tracking-[0.18em]"
              style={{ color: 'var(--text-muted)', opacity: 0.75 }}
            >
              Système
            </div>
          ) : (
            <div
              className="mx-2 mb-1"
              style={{ borderTop: '1px solid var(--border-subtle)', opacity: 0.6 }}
            />
          )}
          <div className="space-y-0.5">
            {systemList.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className="nav-item"
                title={item.label}
                onClick={closeOnNav}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {showLabels && (
                  <span className="text-[13px] font-medium">{item.label}</span>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      {/* Bottom section */}
      <div className="p-2 border-t space-y-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
        {onLogout && (
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg transition-colors hover:opacity-80"
            style={{ color: '#ef4444' }}
            title="Déconnexion"
          >
            <LogOut className="w-4 h-4" />
            {showLabels && <span className="text-[12px]">Déconnexion</span>}
          </button>
        )}
        {/* Le toggle "collapsed" n'a de sens qu'en desktop — sur mobile, le
            drawer se ferme via le X ou le backdrop, pas via collapse. */}
        {!isMobile && (
          <button
            onClick={toggleCollapsed}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="Ctrl+Shift+B"
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
            {showLabels && <span className="text-[12px]">{t('nav.collapse')}</span>}
          </button>
        )}

        {/* Version badge */}
        <div
          className="flex items-center justify-center pt-1"
          style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', opacity: 0.6 }}
          title={`Gungnir v${__APP_VERSION__}`}
        >
          {showLabels ? `Gungnir v${__APP_VERSION__}` : `v${__APP_VERSION__.split('.')[0]}`}
        </div>
      </div>
      </aside>
    </>
  )
}
