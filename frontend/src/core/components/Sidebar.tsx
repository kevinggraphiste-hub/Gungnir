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
} from 'lucide-react'
import { useSidebarStore } from '../stores/sidebarStore'
import { usePluginStore, PluginManifest } from '../stores/pluginStore'
import { useStore } from '../stores/appStore'

// Map icon names from manifests to Lucide components
const ICON_MAP: Record<string, any> = {
  Globe, Mic, BarChart3, Calendar, Plug, Webhook, BookOpen, Code,
  MessageSquare, Bot, Settings2, RadioTower, Brain,
}

export default function Sidebar() {
  const { t } = useTranslation()
  const collapsed = useSidebarStore((s) => s.collapsed)
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed)
  const plugins = usePluginStore((s) => s.plugins)

  const CORE_ITEMS = [
    { path: '/', icon: MessageSquare, label: t('nav.chat') },
    { path: '/agent', icon: Bot, label: t('nav.agent') },
  ]

  // Plugin nav items (sorted by sidebar_position, only enabled ones)
  // Analytics is placed just before Settings (bottom section)
  const enabledPlugins = plugins
    .filter((p) => p.enabled)
    .sort((a, b) => a.sidebar_position - b.sidebar_position)

  const regularPlugins = enabledPlugins
    .filter((p) => p.name !== 'analytics')
    .map((p: PluginManifest) => ({
      path: p.route,
      icon: ICON_MAP[p.icon] || Globe,
      label: p.display_name,
    }))

  const analyticsPlugin = enabledPlugins
    .filter((p) => p.name === 'analytics')
    .map((p: PluginManifest) => ({
      path: p.route,
      icon: ICON_MAP[p.icon] || Globe,
      label: p.display_name,
    }))

  const allItems = [
    ...CORE_ITEMS,
    ...regularPlugins,
    ...analyticsPlugin,
    { path: '/settings', icon: Settings2, label: t('nav.settings') },
  ]

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

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {allItems.map((item) => (
          <NavLink key={item.path} to={item.path} className="nav-item">
            <item.icon className="w-4 h-4 flex-shrink-0" />
            {!collapsed && (
              <span className="text-[13px] font-medium">{item.label}</span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Collapse toggle */}
      <div className="p-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
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
      </div>
    </aside>
  )
}
