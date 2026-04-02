/**
 * Gungnir — Global keyboard shortcuts
 *
 * Ctrl+B         → toggle Chat sidebar (conversation list)
 * Ctrl+Shift+B   → toggle both sidebars (main nav + chat)
 */
import { useEffect } from 'react'
import { useSidebarStore } from '../stores/sidebarStore'

export function useGlobalKeyboard() {
  const toggleSidebar = useSidebarStore((s) => s.toggleCollapsed)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Shift+B → toggle both sidebars
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        toggleSidebar()
        // Also dispatch custom event for Chat sidebar to listen to
        window.dispatchEvent(new CustomEvent('gungnir:toggle-chat-sidebar'))
        return
      }

      // Ctrl+B → toggle Chat sidebar only (dispatched as custom event)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('gungnir:toggle-chat-sidebar'))
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleSidebar])
}
