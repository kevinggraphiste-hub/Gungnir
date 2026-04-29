/**
 * Gungnir — Sidebar Store (Zustand)
 *
 * `collapsed` (desktop) = persistant via localStorage (icônes seules vs label).
 * `mobileOpen` (mobile) = volatile, pas persisté — c'est un état de UI éphémère
 * (drawer ouvert ou fermé). Sur mobile la sidebar est cachée par défaut, le
 * burger button (App shell) bascule cet état.
 */
import { create } from 'zustand'

interface SidebarState {
  collapsed: boolean
  toggleCollapsed: () => void
  setCollapsed: (collapsed: boolean) => void
  mobileOpen: boolean
  toggleMobileOpen: () => void
  setMobileOpen: (open: boolean) => void
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

  mobileOpen: false,

  toggleMobileOpen: () => set((state) => ({ mobileOpen: !state.mobileOpen })),

  setMobileOpen: (open) => set({ mobileOpen: open }),
}))
