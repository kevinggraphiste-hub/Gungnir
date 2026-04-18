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
  LogOut,
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
  const onLogout = useStore((s) => s.onLogout)

  // Core items (hardcoded) — affichés dans la section "core"
  const CORE_ITEMS = [
    { path: '/', icon: MessageSquare, label: t('nav.chat') },
    { path: '/agent', icon: Bot, label: t('nav.agent') },
  ]

  // Plugin nav items triés par sidebar_position (seulement ceux activés)
  const enabledPlugins = plugins
    .filter((p) => p.enabled)
    .sort((a, b) => a.sidebar_position - b.sidebar_position)

  const toItem = (p: PluginManifest) => ({
    path: p.route,
    icon: ICON_MAP[p.icon] || Globe,
    label: p.display_name,
    version: p.version,
  })

  // Répartition par section (fallback "tools" si le manifest n'en déclare pas)
  const pluginsBySection: Record<string, ReturnType<typeof toItem>[]> = {}
  for (const p of enabledPlugins) {
    const section = p.sidebar_section || 'tools'
    if (!pluginsBySection[section]) pluginsBySection[section] = []
    pluginsBySection[section].push(toItem(p))
  }

  // Ordre d'affichage des sections + libellés
  const SECTION_ORDER: Array<{ key: string; label: string }> = [
    { key: 'core', label: 'Essentiels' },
    { key: 'tools', label: 'Outils' },
    { key: 'integrations', label: 'Intégrations' },
  ]

  // Section "core" : on injecte les items hardcodés devant les plugins "core"
  const coreSection = [...CORE_ITEMS, ...(pluginsBySection['core'] || [])]
  const groups: Array<{ key: string; label: string; items: Array<{ path: string; icon: any; label: string; version?: string }> }> = []
  for (const s of SECTION_ORDER) {
    const items = s.key === 'core' ? coreSection : (pluginsBySection[s.key] || [])
    if (items.length > 0) groups.push({ key: s.key, label: s.label, items })
  }
  // Toute section déclarée qui ne fait pas partie de l'ordre connu — on la pousse à la fin
  for (const key of Object.keys(pluginsBySection)) {
    if (!SECTION_ORDER.find(s => s.key === key)) {
      groups.push({ key, label: key.charAt(0).toUpperCase() + key.slice(1), items: pluginsBySection[key] })
    }
  }

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
      <nav className="flex-1 p-2 overflow-y-auto">
        {groups.map((group, gi) => (
          <div key={group.key} className={gi > 0 ? 'mt-3' : ''}>
            {!collapsed && (
              <div
                className="px-2 pb-1 text-[9px] font-bold uppercase tracking-widest"
                style={{ color: 'var(--text-muted)', opacity: 0.75 }}
              >
                {group.label}
              </div>
            )}
            {collapsed && gi > 0 && (
              <div
                className="mx-2 my-1.5"
                style={{ borderTop: '1px solid var(--border-subtle)', opacity: 0.6 }}
              />
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className="nav-item"
                  title={item.version ? `${item.label} v${item.version}` : item.label}
                >
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  {!collapsed && (
                    <span className="text-[13px] font-medium">{item.label}</span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
        {/* Paramètres isolé en bas de la navigation principale */}
        <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <NavLink to="/settings" className="nav-item" title={t('nav.settings')}>
            <Settings2 className="w-4 h-4 flex-shrink-0" />
            {!collapsed && <span className="text-[13px] font-medium">{t('nav.settings')}</span>}
          </NavLink>
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
          style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.6 }}
          title={`Gungnir v${__APP_VERSION__}`}
        >
          {collapsed ? `v${__APP_VERSION__.split('.')[0]}` : `Gungnir v${__APP_VERSION__}`}
        </div>
      </div>
    </aside>
  )
}
