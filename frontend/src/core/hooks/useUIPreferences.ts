/**
 * Gungnir — Accessibilité / préférences typographiques (persistées par user).
 *
 * Gère 4 axes : famille de police, style (sans/serif), taille, interligne.
 * Le hook :
 *   - charge les prefs via GET /api/config/user/ui au montage
 *   - applique les data-attrs sur <html> → CSS prend le relais via variables
 *   - expose un setter qui POST les changements
 *
 * Fallback localStorage pour que l'UI ne "flash" pas en police par défaut le
 * temps que l'API réponde.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../services/api'

export type UIPrefs = {
  font_family: 'inter' | 'opendyslexic' | 'atkinson'
  font_style: 'sans' | 'serif'
  font_size: 'small' | 'normal' | 'large'
  line_spacing: 'tight' | 'normal' | 'loose'
}

export const DEFAULT_UI_PREFS: UIPrefs = {
  font_family: 'inter',
  font_style: 'sans',
  font_size: 'normal',
  line_spacing: 'normal',
}

const STORAGE_KEY = 'gungnir_ui_prefs'

function applyToDOM(prefs: UIPrefs) {
  const root = document.documentElement
  root.setAttribute('data-font', prefs.font_family)
  root.setAttribute('data-fontstyle', prefs.font_style)
  root.setAttribute('data-fontsize-pref', prefs.font_size)
  root.setAttribute('data-linespacing', prefs.line_spacing)
}

function readLocal(): UIPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_UI_PREFS
    const parsed = JSON.parse(raw) as Partial<UIPrefs>
    return { ...DEFAULT_UI_PREFS, ...parsed }
  } catch {
    return DEFAULT_UI_PREFS
  }
}

export function useUIPreferences() {
  const [prefs, setPrefs] = useState<UIPrefs>(() => {
    const local = readLocal()
    applyToDOM(local)
    return local
  })
  const [loaded, setLoaded] = useState(false)

  // Charge les prefs serveur au boot et écrase le cache local si réponse OK.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await apiFetch('/api/config/user/ui')
        if (!res.ok) { setLoaded(true); return }
        const data = await res.json() as Partial<UIPrefs>
        if (cancelled) return
        const merged: UIPrefs = { ...DEFAULT_UI_PREFS, ...data }
        setPrefs(merged)
        applyToDOM(merged)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      } catch {
        // backend pas prêt → on reste sur le localStorage
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const update = useCallback(async (patch: Partial<UIPrefs>) => {
    const next: UIPrefs = { ...prefs, ...patch }
    setPrefs(next)
    applyToDOM(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    try {
      await apiFetch('/api/config/user/ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    } catch {
      // sauvegarde serveur silencieuse, l'UI reste à jour via le state
    }
  }, [prefs])

  return { prefs, update, loaded }
}
