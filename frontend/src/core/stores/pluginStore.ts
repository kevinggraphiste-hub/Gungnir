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
}

interface PluginState {
  plugins: PluginManifest[]
  pluginsLoaded: boolean
  setPlugins: (plugins: PluginManifest[]) => void
  togglePlugin: (name: string) => void
  isPluginEnabled: (name: string) => boolean
  loadPlugins: () => Promise<void>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  pluginsLoaded: false,
  setPlugins: (plugins) => set({ plugins }),

  togglePlugin: (name) =>
    set((state) => ({
      plugins: state.plugins.map((p) =>
        p.name === name ? { ...p, enabled: !p.enabled } : p
      ),
    })),

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
