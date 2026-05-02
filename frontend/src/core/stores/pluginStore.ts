/**
 * Gungnir — Plugin Store (Zustand)
 *
 * Manages the plugin registry: which plugins are available, enabled, and their metadata.
 * Populated from the backend /api/plugins/status endpoint at startup.
 */
import { create } from 'zustand'
import { apiFetch } from '../services/api'

export interface PluginManifest {
  name: string
  display_name: string
  version: string
  icon: string
  route: string
  sidebar_position: number
  sidebar_section: string
  enabled: boolean
  core_required?: boolean
}

interface PluginState {
  plugins: PluginManifest[]
  pluginsLoaded: boolean
  setPlugins: (plugins: PluginManifest[]) => void
  togglePlugin: (name: string, enabled?: boolean) => Promise<{ ok: boolean; error?: string }>
  isPluginEnabled: (name: string) => boolean
  loadPlugins: () => Promise<void>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  pluginsLoaded: false,
  setPlugins: (plugins) => set({ plugins }),

  togglePlugin: async (name, enabled) => {
    // Optimistic update + rollback en cas d'erreur backend
    const before = get().plugins
    const target = before.find(p => p.name === name)
    if (!target) return { ok: false, error: 'Plugin introuvable' }
    if (target.core_required) {
      return { ok: false, error: `Plugin '${name}' est protégé (core_required) — ne peut pas être désactivé.` }
    }
    const next = enabled === undefined ? !target.enabled : enabled
    set({ plugins: before.map(p => (p.name === name ? { ...p, enabled: next } : p)) })
    try {
      const { api } = await import('../services/api')
      const r = await api.togglePlugin(name, next)
      if (r?.ok) return { ok: true }
      set({ plugins: before })
      return { ok: false, error: r?.error || 'Erreur backend' }
    } catch (err: any) {
      set({ plugins: before })
      return { ok: false, error: err?.message || 'Erreur réseau' }
    }
  },

  isPluginEnabled: (name) => {
    return get().plugins.some((p) => p.name === name && p.enabled)
  },

  loadPlugins: async () => {
    try {
      const res = await apiFetch('/api/plugins/status')
      if (res.ok) {
        const data = await res.json()
        set({ plugins: data.plugins || [], pluginsLoaded: true })
      } else {
        set({ pluginsLoaded: true })
      }
    } catch (err) {
      console.warn('Failed to load plugins:', err)
      set({ pluginsLoaded: true })
    }
  },
}))
