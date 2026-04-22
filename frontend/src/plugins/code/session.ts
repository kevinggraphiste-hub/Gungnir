// ── Session persistence (survives plugin switches) ──────────────────────────

import type { SCSession } from './types'

export const SC_STORAGE_KEY = 'spearcode_session'

export function loadSession(): SCSession | null {
  try {
    const raw = localStorage.getItem(SC_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function saveSession(s: SCSession) {
  try { localStorage.setItem(SC_STORAGE_KEY, JSON.stringify(s)) } catch {}
}
