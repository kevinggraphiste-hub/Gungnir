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
  LogOut,
} from 'lucide-react'
import { useSidebarStore } from '../stores/sidebarStore'
import { usePluginStore, PluginManifest } from '../stores/pluginStore'
import { useStore } from '../stores/appStore'

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
  const plugins = usePluginStore((s) => s.plugins)
  const onLogout = useStore((s) => s.onLogout)

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

  return (
    <aside
      className="h-screen flex flex-col border-r transition-all duration-300"
      style={{
        width: collapsed ? '64px' : '200px',
        background: 'var(--bg-primary)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Logo + Agent name */}
      <div
        className="px-3 py-4 border-b flex items-center gap-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <img src="/logo.png" alt="Gungnir" className="w-8 h-8 rounded-full object-contain" />
        {!collapsed && (
          <span className="font-bold text-sm tracking-wide gradient-text">
            Gungnir
          </span>
        )}
      </div>

      {/* Navigation — PLUGINS puis SYSTÈME à la suite */}
      <nav className="flex-1 p-2 overflow-y-auto">
        {/* Section PLUGINS — compteur total à droite du titre */}
        <div>
          {!collapsed ? (
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
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && (
                  <span className="text-[13px] font-medium">{item.label}</span>
                )}
              </NavLink>
            ))}
          </div>
        </div>

        {/* Section SYSTÈME — Modèles / Analytics / Settings, à la suite de PLUGINS */}
        <div className="mt-4">
          {!collapsed ? (
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
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && (
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
            {!collapsed && <span className="text-[12px]">Déconnexion</span>}
          </button>
        )}
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
          {!collapsed && <span className="text-[12px]">{t('nav.collapse')}</span>}
        </button>

        {/* Version badge */}
        <div
          className="flex items-center justify-center pt-1"
          style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', opacity: 0.6 }}
          title={`Gungnir v${__APP_VERSION__}`}
        >
          {collapsed ? `v${__APP_VERSION__.split('.')[0]}` : `Gungnir v${__APP_VERSION__}`}
        </div>
      </div>
    </aside>
  )
}
