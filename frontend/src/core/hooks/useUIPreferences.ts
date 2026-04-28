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
  // font_size : px direct (11-18). Avant on avait small/normal/large mais
  // le rendu était à peine visible (les composants utilisent des fontSize
  // inline en dur). On a basculé sur le pattern SpearCode : zoom global
  // appliqué au body via CSS, qui scale TOUT proportionnellement.
  // Backward-compat : si on lit small/normal/large depuis le serveur ou
  // localStorage, on convertit dans `_normalize_font_size`.
  font_size: number
  line_spacing: 'tight' | 'normal' | 'loose'
  letter_spacing: 'normal' | 'wide' | 'wider'
  word_spacing: 'normal' | 'wide' | 'wider'
  reduced_motion: boolean
  high_contrast: boolean
  timezone: string  // IANA TZ (ex: 'Europe/Paris', 'America/New_York')
}

export const DEFAULT_UI_PREFS: UIPrefs = {
  font_family: 'inter',
  font_style: 'sans',
  font_size: 14,         // px — base raisonnable
  line_spacing: 'normal',
  letter_spacing: 'normal',
  word_spacing: 'normal',
  reduced_motion: false,
  high_contrast: false,
  timezone: 'Europe/Paris',
}

// Map des valeurs legacy small/normal/large vers leur équivalent px.
// Permet de migrer en douceur les users qui ont déjà ces valeurs en DB
// ou en localStorage sans crash.
const _LEGACY_SIZE_MAP: Record<string, number> = {
  small: 13, normal: 14, large: 17,
}

function _normalize_font_size(v: any): number {
  if (typeof v === 'number') {
    if (Number.isFinite(v) && v >= 10 && v <= 22) return Math.round(v)
    return DEFAULT_UI_PREFS.font_size
  }
  if (typeof v === 'string') {
    if (v in _LEGACY_SIZE_MAP) return _LEGACY_SIZE_MAP[v]
    const n = Number(v)
    if (Number.isFinite(n) && n >= 10 && n <= 22) return Math.round(n)
  }
  return DEFAULT_UI_PREFS.font_size
}

/** Lit la TZ IANA du navigateur (ex: 'Europe/Paris', 'America/Los_Angeles').
 *  Fallback 'Europe/Paris' si l'API Intl est bizarre (vieux navigateur). */
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'
  } catch {
    return 'Europe/Paris'
  }
}

const STORAGE_KEY = 'gungnir_ui_prefs'

function applyToDOM(prefs: UIPrefs) {
  const root = document.documentElement
  root.setAttribute('data-font', prefs.font_family)
  root.setAttribute('data-fontstyle', prefs.font_style)
  root.setAttribute('data-linespacing', prefs.line_spacing)
  root.setAttribute('data-letterspacing', prefs.letter_spacing)
  root.setAttribute('data-wordspacing', prefs.word_spacing)
  if (prefs.reduced_motion) root.setAttribute('data-motion', 'reduced')
  else root.removeAttribute('data-motion')
  if (prefs.high_contrast) root.setAttribute('data-contrast', 'high')
  else root.removeAttribute('data-contrast')

  // Vraie taille typo — on pilote `--app-font-base` (et son alias
  // `--app-font-size`). Les autres CSS vars (--font-xs/sm/md/lg/xl)
  // sont en calc() proportionnel dans index.css, donc l'ensemble de
  // la cascade typo grandit/rétrécit avec le slider, sans zoom CSS.
  // SpearCode (route /code-frame) gère son propre uiFontSize côté
  // iframe, on lui laisse 14px (taille neutre) pour ne pas combiner.
  const isCodeFrame = (
    typeof window !== 'undefined'
    && (window.location.pathname === '/code-frame'
        || window.location.pathname.startsWith('/code-frame/'))
  )
  const size = _normalize_font_size(prefs.font_size)
  const px = `${isCodeFrame ? 14 : size}px`
  root.style.setProperty('--app-font-base', px)
  root.style.setProperty('--app-font-size', px)
  // On pose AUSSI font-size sur <html> pour que les classes Tailwind
  // text-xs/sm/base/lg (qui sont en rem = relatif à <html>) scalent
  // avec le slider. Sans ça, seuls les composants utilisant les CSS
  // vars suivraient et les autres resteraient figés à 16px.
  root.style.fontSize = px
  if (typeof document !== 'undefined' && document.body) {
    // Nettoyage du legacy zoom appliqué par les anciennes versions —
    // sinon on combine zoom + nouvelle taille = double effet.
    document.body.style.zoom = ''
  }
}

function readLocal(): UIPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_UI_PREFS
    const parsed = JSON.parse(raw) as Partial<UIPrefs>
    const merged = { ...DEFAULT_UI_PREFS, ...parsed }
    // Coerce font_size en nombre (rétrocompat avec l'ancien format
    // 'small'|'normal'|'large').
    merged.font_size = _normalize_font_size((parsed as any).font_size)
    return merged
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
        // Coerce le font_size serveur (peut être encore 'small'|'normal'
        // |'large' si le user n'a pas re-saved depuis la migration).
        merged.font_size = _normalize_font_size((data as any).font_size)
        setPrefs(merged)
        applyToDOM(merged)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))

        // Auto-détection TZ navigateur : si le serveur retourne la TZ
        // par défaut (`Europe/Paris`) alors que le navigateur en donne
        // une différente, on pousse celle du navigateur en silence.
        // L'user peut toujours l'override manuellement dans Settings.
        try {
          const detected = detectBrowserTimezone()
          const serverTz = (data.timezone as string | undefined) || 'Europe/Paris'
          if (detected && detected !== serverTz && detected !== 'Europe/Paris') {
            await apiFetch('/api/config/user/ui', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ timezone: detected }),
            })
            const next = { ...merged, timezone: detected }
            if (!cancelled) setPrefs(next)
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
          }
        } catch { /* fail silencieux — la TZ par défaut reste */ }
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
