/**
 * Gungnir — Sidebar Store (Zustand)
 */
import { create } from 'zustand'

interface SidebarState {
  collapsed: boolean
  toggleCollapsed: () => void
  setCollapsed: (collapsed: boolean) => void
}

export const useSidebarStore = create<SidebarState>((set) => ({
  collapsed: localStorage.getItem('gungnir_sidebar_collapsed') === 'true',

  toggleCollapsed: () =>
    set((state) => {
      const next = !state.collapsed
      localStorage.setItem('gungnir_sidebar_collapsed', String(next))
      return { collapsed: next }
    }),

  setCollapsed: (collapsed) => {
    localStorage.setItem('gungnir_sidebar_collapsed', String(collapsed))
    set({ collapsed })
  },
}))
