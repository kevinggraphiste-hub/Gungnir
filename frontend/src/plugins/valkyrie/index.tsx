/**
 * Valkyrie — tableau de suivi de tâches multi-projets.
 *
 * Les Valkyries trient qui va où : ici, les cartes vont dans leur statut.
 * Une seule grille carrée réorganisable à la volée (drag & drop), cartes
 * pliables avec sous-tâches, statuts built-in + custom.
 *
 * Aligné charte ScarletWolf : fond #080808, scarlet #dc2626, border-radius
 * 4/8/12, typos Inter + JetBrains Mono (pas de Instrument Serif — la charte
 * Gungnir utilise Inter pour les titres).
 *
 * © ScarletWolf — Licence propriétaire
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutGrid, Plus, Trash2, Archive, Save, ChevronDown, ChevronRight,
  X, Check, Loader2, Edit3, GripVertical, Search, Download, Tag as TagIcon,
} from 'lucide-react'
import InfoButton from '@core/components/InfoButton'
import manifest from './manifest.json'

const API = '/api/plugins/valkyrie'
const PLUGIN_VERSION = (manifest as { version?: string }).version || '?'

// ── Types ────────────────────────────────────────────────────────────────

interface ProjectT {
  id: number
  title: string
  description: string
  archived: boolean
  position: number
  created_at: string | null
  updated_at: string | null
}

interface StatusT {
  key: string
  label: string
  color: string
  builtin: boolean
  position: number
  id?: number // présent seulement pour les custom
  project_id?: number | null
}

interface SubtaskT {
  id: string
  label: string
  done: boolean
}

interface CardT {
  id: number
  project_id: number
  title: string
  subtitle: string
  description: string
  status_key: string
  position: number
  expanded: boolean
  subtasks: SubtaskT[]
  subtasks2: SubtaskT[]
  subtasks2_title: string
  tags: string[]
  created_at: string | null
  updated_at: string | null
}

interface TagEntryT { label: string; count: number }

// Palette de couleurs pour les tags : dérivée du hash du label → index stable
const TAG_COLORS = [
  '#dc2626', '#ef4444', '#f97316', '#f59e0b',
  '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e',
]

function colorForTag(label: string): string {
  // Hash stable — simple djb2 tronqué → index dans la palette
  let hash = 5381
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) + hash) + label.charCodeAt(i)
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

// ── Helpers ──────────────────────────────────────────────────────────────

function newSubtaskId(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}`
}

async function jget<T = any>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

async function jsend<T = any>(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: any): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ── Main Component ──────────────────────────────────────────────────────

export default function ValkyriePlugin() {
  const [projects, setProjects] = useState<ProjectT[]>([])
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null)
  const [statuses, setStatuses] = useState<StatusT[]>([])
  const [cards, setCards] = useState<CardT[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)
  const [showStatusModal, setShowStatusModal] = useState(false)
  const [palette, setPalette] = useState<string[]>([])
  const [newCardTitle, setNewCardTitle] = useState('')
  const [newCardStatus, setNewCardStatus] = useState('todo')
  const [showProjectMenu, setShowProjectMenu] = useState(false)
  const [savingFlash, setSavingFlash] = useState<'ok' | 'err' | null>(null)

  // Recherche + filtre tags
  const [searchQuery, setSearchQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [allTags, setAllTags] = useState<TagEntryT[]>([])
  const [showExportMenu, setShowExportMenu] = useState(false)

  const activeProject = useMemo(
    () => projects.find(p => p.id === activeProjectId) || null,
    [projects, activeProjectId]
  )

  // ── Initial load ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [pRes, sRes, palRes] = await Promise.all([
          jget<{ projects: ProjectT[] }>(`${API}/projects`),
          jget<{ statuses: StatusT[] }>(`${API}/statuses`),
          jget<{ colors: string[] }>(`${API}/palette`),
        ])
        if (cancelled) return
        setProjects(pRes.projects || [])
        setStatuses(sRes.statuses || [])
        setPalette(palRes.colors || [])
        const first = (pRes.projects || [])[0]
        if (first) setActiveProjectId(first.id)
      } catch (err) {
        console.warn('Valkyrie load error:', err)
      } finally {
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Load cards quand le projet actif change ─────────────────────────
  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
        if (cancelled) return
        setCards(r.cards || [])
      } catch (err) {
        console.warn('Valkyrie cards error:', err)
      }
    })()
    return () => { cancelled = true }
  }, [activeProjectId])

  // ── Tags : fetch la liste globale user (autocomplete + compteurs) ──
  const refreshTags = useCallback(async () => {
    try {
      const r = await jget<{ tags: TagEntryT[] }>(`${API}/tags`)
      setAllTags(r.tags || [])
    } catch { /* silencieux */ }
  }, [])
  useEffect(() => { refreshTags() }, [refreshTags, cards.length])

  // ── Project mutations ──────────────────────────────────────────────
  const saveProject = useCallback(async (updates: Partial<ProjectT>) => {
    if (!activeProject) return
    try {
      const r = await jsend<{ project: ProjectT }>(
        `${API}/projects/${activeProject.id}`, 'PUT', updates
      )
      setProjects(prev => prev.map(p => p.id === r.project.id ? r.project : p))
      setSavingFlash('ok')
      setTimeout(() => setSavingFlash(null), 1500)
    } catch {
      setSavingFlash('err')
      setTimeout(() => setSavingFlash(null), 2500)
    }
  }, [activeProject])

  const createProject = useCallback(async () => {
    try {
      const r = await jsend<{ project: ProjectT }>(`${API}/projects`, 'POST', {
        title: 'Nouveau tableau',
      })
      setProjects(prev => [...prev, r.project])
      setActiveProjectId(r.project.id)
      setShowProjectMenu(false)
    } catch (err) {
      console.warn('createProject failed:', err)
    }
  }, [])

  const archiveProject = useCallback(async () => {
    if (!activeProject) return
    if (!confirm(`Archiver "${activeProject.title}" ? Tu peux le restaurer plus tard.`)) return
    await saveProject({ archived: true })
    // Bascule sur un autre projet non archivé
    const remaining = projects.filter(p => p.id !== activeProject.id && !p.archived)
    setActiveProjectId(remaining[0]?.id || null)
  }, [activeProject, projects, saveProject])

  const deleteProject = useCallback(async () => {
    if (!activeProject) return
    if (!confirm(`Supprimer DÉFINITIVEMENT "${activeProject.title}" et toutes ses cartes ?`)) return
    try {
      await jsend(`${API}/projects/${activeProject.id}`, 'DELETE')
      const remaining = projects.filter(p => p.id !== activeProject.id)
      setProjects(remaining)
      setActiveProjectId(remaining[0]?.id || null)
    } catch (err) {
      console.warn('deleteProject failed:', err)
    }
  }, [activeProject, projects])

  // ── Card mutations ─────────────────────────────────────────────────
  const createCard = useCallback(async () => {
    if (!activeProjectId) return
    const title = newCardTitle.trim()
    if (!title) return
    try {
      const r = await jsend<{ card: CardT }>(`${API}/projects/${activeProjectId}/cards`, 'POST', {
        title, status_key: newCardStatus, position: cards.length,
      })
      setCards(prev => [...prev, r.card])
      setNewCardTitle('')
    } catch (err) {
      console.warn('createCard failed:', err)
    }
  }, [activeProjectId, newCardTitle, newCardStatus, cards.length])

  const updateCard = useCallback(async (cardId: number, updates: Partial<CardT>, optimistic = true) => {
    if (optimistic) {
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, ...updates } : c))
    }
    try {
      const r = await jsend<{ card: CardT }>(`${API}/cards/${cardId}`, 'PUT', updates)
      setCards(prev => prev.map(c => c.id === cardId ? r.card : c))
    } catch (err) {
      console.warn('updateCard failed:', err)
    }
  }, [])

  const deleteCard = useCallback(async (cardId: number) => {
    if (!confirm('Supprimer cette carte ?')) return
    try {
      await jsend(`${API}/cards/${cardId}`, 'DELETE')
      setCards(prev => prev.filter(c => c.id !== cardId))
    } catch (err) {
      console.warn('deleteCard failed:', err)
    }
  }, [])

  const reorderCards = useCallback(async (items: { id: number; position: number; status_key?: string }[]) => {
    try {
      await jsend(`${API}/cards/reorder`, 'POST', { items })
    } catch (err) {
      console.warn('reorder failed:', err)
    }
  }, [])

  // ── Status mutations ───────────────────────────────────────────────
  const createStatus = useCallback(async (label: string, color: string) => {
    try {
      const r = await jsend<{ status: StatusT }>(`${API}/statuses`, 'POST', { label, color })
      setStatuses(prev => [...prev, r.status])
      setShowStatusModal(false)
    } catch (err) {
      console.warn('createStatus failed:', err)
    }
  }, [])

  const deleteStatus = useCallback(async (statusId: number) => {
    if (!confirm('Supprimer ce statut ? Les cartes qui l\'utilisent basculeront sur "À faire".')) return
    try {
      const r = await jsend<{ reassigned_to: string }>(`${API}/statuses/${statusId}`, 'DELETE')
      setStatuses(prev => prev.filter(s => s.id !== statusId))
      // Rafraîchit les cartes qui pourraient avoir changé de statut
      if (activeProjectId) {
        const c = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
        setCards(c.cards || [])
      }
    } catch (err) {
      console.warn('deleteStatus failed:', err)
    }
  }, [activeProjectId])

  // ── Drag & drop state ──────────────────────────────────────────────
  const [draggedId, setDraggedId] = useState<number | null>(null)
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null)

  const handleDragStart = useCallback((e: React.DragEvent, cardId: number) => {
    setDraggedId(cardId)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', String(cardId)) } catch { /* ignore */ }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, overIdx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropTargetIdx(overIdx)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, dropIdx: number) => {
    e.preventDefault()
    if (draggedId == null) return
    const visible = filter == null ? cards : cards.filter(c => c.status_key === filter)
    const sourceIdx = visible.findIndex(c => c.id === draggedId)
    if (sourceIdx < 0 || sourceIdx === dropIdx) {
      setDraggedId(null); setDropTargetIdx(null); return
    }
    // Réorganise la liste visible, puis réinjecte les cartes filtrées à leur place
    const reordered = [...visible]
    const [moved] = reordered.splice(sourceIdx, 1)
    reordered.splice(Math.min(dropIdx, reordered.length), 0, moved)
    // Merge avec les cartes filtrées : on conserve l'ordre global de `cards`
    // en remplaçant chaque slot de la liste visible par l'ordre reordered.
    const mergedIter = reordered[Symbol.iterator]()
    const merged = cards.map(c => {
      if (filter != null && c.status_key !== filter) return c
      return mergedIter.next().value || c
    })
    // Applique positions 0..N-1 dans l'ordre global
    const withPositions = merged.map((c, idx) => ({ ...c, position: idx }))
    setCards(withPositions)
    reorderCards(withPositions.map(c => ({ id: c.id, position: c.position })))
    setDraggedId(null); setDropTargetIdx(null)
  }, [cards, filter, draggedId, reorderCards])

  const handleDragEnd = useCallback(() => {
    setDraggedId(null); setDropTargetIdx(null)
  }, [])

  // ── Render ──────────────────────────────────────────────────────────
  const visibleCards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const tags = tagFilter.map(t => t.toLowerCase())
    const filtered = cards.filter(c => {
      if (filter != null && c.status_key !== filter) return false
      if (tags.length > 0) {
        const cardTagsLower = (c.tags || []).map(t => t.toLowerCase())
        // Match ANY des tags sélectionnés (plus permissif qu'un ET)
        if (!tags.some(t => cardTagsLower.includes(t))) return false
      }
      if (q) {
        const hay = [
          c.title, c.subtitle, c.description,
          ...(c.tags || []),
          ...(c.subtasks || []).map(s => s.label),
          ...(c.subtasks2 || []).map(s => s.label),
        ].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return [...filtered].sort((a, b) => a.position - b.position)
  }, [cards, filter, searchQuery, tagFilter])

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const c of cards) counts[c.status_key] = (counts[c.status_key] || 0) + 1
    return counts
  }, [cards])

  const getStatus = useCallback((key: string): StatusT => {
    return statuses.find(s => s.key === key) || statuses[0] || {
      key, label: key, color: '#7a8a9b', builtin: false, position: 0,
    }
  }, [statuses])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--scarlet)' }} />
      </div>
    )
  }

  return (
    <div className="flex-1 h-screen overflow-y-auto p-6" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div className="max-w-7xl mx-auto space-y-4">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <LayoutGrid className="w-6 h-6" style={{ color: 'var(--scarlet)' }} />
            <div>
              <div className="flex items-baseline gap-2">
                <h1 className="text-xl font-bold">Valkyrie</h1>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    background: 'color-mix(in srgb, var(--scarlet) 10%, transparent)',
                    color: 'color-mix(in srgb, var(--scarlet) 80%, var(--text-muted))',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)',
                  }}>
                  v{PLUGIN_VERSION}
                </span>
                {savingFlash && (
                  <span className="text-[10px]"
                    style={{ color: savingFlash === 'ok' ? 'var(--accent-success, #10b981)' : 'var(--accent-error, #ef4444)' }}>
                    {savingFlash === 'ok' ? '✓ enregistré' : '✗ échec'}
                  </span>
                )}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Suivi de tâches — une grille, statuts flexibles, drag & drop.
              </p>
            </div>
          </div>
          {/* Project switcher */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowProjectMenu(v => !v)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}>
              <span>{activeProject?.title || 'Aucun projet'}</span>
              <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
            </button>
            {showProjectMenu && (
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)',
                minWidth: 240, background: 'var(--bg-secondary)',
                border: '1px solid var(--border)', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 20, padding: 4,
              }}>
                {projects.filter(p => !p.archived).map(p => (
                  <button key={p.id}
                    onClick={() => { setActiveProjectId(p.id); setShowProjectMenu(false) }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '6px 10px', borderRadius: 6,
                      background: p.id === activeProjectId ? 'color-mix(in srgb, var(--scarlet) 12%, transparent)' : 'transparent',
                      color: p.id === activeProjectId ? 'var(--scarlet)' : 'var(--text-primary)',
                      border: 'none', cursor: 'pointer', fontSize: 13,
                    }}>
                    {p.title}
                  </button>
                ))}
                <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                <button onClick={createProject}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    width: '100%', textAlign: 'left',
                    padding: '6px 10px', borderRadius: 6,
                    background: 'transparent', color: 'var(--scarlet)',
                    border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                  }}>
                  <Plus className="w-3.5 h-3.5" /> Nouveau tableau
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Project header (titre + desc + actions + new card) ── */}
        {activeProject && (
          <div className="rounded-xl p-5" style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            position: 'relative', overflow: 'hidden',
          }}>
            {/* Barre scarlet à gauche */}
            <div style={{
              position: 'absolute', top: 0, left: 0, width: 3, height: '100%',
              background: 'linear-gradient(180deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
            }} />
            <div className="flex items-start justify-between gap-4">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="text-[10px] font-mono uppercase tracking-[2px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  Projet actif
                </div>
                <EditableText
                  value={activeProject.title}
                  onSave={v => saveProject({ title: v })}
                  className="text-2xl font-bold tracking-tight"
                  style={{ color: 'var(--text-primary)' }}
                  singleLine
                />
                <EditableText
                  value={activeProject.description}
                  onSave={v => saveProject({ description: v })}
                  placeholder="Ajoute une description…"
                  className="text-sm mt-2"
                  style={{ color: 'var(--text-secondary)', maxWidth: 820, lineHeight: 1.55 }}
                />
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={deleteProject}
                  className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                  title="Supprimer le projet">
                  <Trash2 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
                <button onClick={archiveProject}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                  <Archive className="w-3.5 h-3.5" /> Archiver
                </button>
              </div>
            </div>

            {/* Ligne nouvelle carte intégrée */}
            <div className="mt-4 pt-4" style={{ borderTop: '1px dashed var(--border)' }}>
              <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 180px auto' }}>
                <input
                  value={newCardTitle}
                  onChange={e => setNewCardTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createCard()}
                  placeholder="Nouvelle carte — titre de la tâche…"
                  className="px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                  style={{
                    background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    color: 'var(--text-primary)',
                  }}
                />
                <select
                  value={newCardStatus}
                  onChange={e => setNewCardStatus(e.target.value)}
                  className="px-3 py-2 rounded-lg text-sm outline-none"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  {statuses.map(s => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
                <button onClick={createCard} disabled={!newCardTitle.trim()}
                  className="flex items-center justify-center rounded-lg transition-all disabled:opacity-40"
                  style={{
                    width: 36, height: 36,
                    background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
                    color: '#fff', border: 'none',
                    boxShadow: newCardTitle.trim() ? '0 0 12px color-mix(in srgb, var(--scarlet) 30%, transparent)' : 'none',
                    cursor: newCardTitle.trim() ? 'pointer' : 'not-allowed',
                  }}
                  title="Ajouter la carte">
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Search bar ─────────────────────────────────────── */}
        {activeProject && (
          <div className="flex items-center gap-2 flex-wrap">
            <div style={{ position: 'relative', flex: 1, minWidth: 240 }}>
              <Search className="w-3.5 h-3.5" style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-muted)', pointerEvents: 'none',
              }} />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Rechercher dans les cartes (titre, description, sous-tâches, tags…)"
                className="w-full rounded-lg text-sm outline-none"
                style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  color: 'var(--text-primary)', padding: '8px 10px 8px 32px',
                }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)', padding: 2,
                  }}
                  title="Effacer"><X className="w-3.5 h-3.5" /></button>
              )}
            </div>
            <ExportMenu
              project={activeProject}
              cards={cards}
              statuses={statuses}
              open={showExportMenu}
              onToggle={() => setShowExportMenu(v => !v)}
              onClose={() => setShowExportMenu(false)}
            />
          </div>
        )}

        {/* ── Filter bar (statuts) ──────────────────────────────── */}
        {activeProject && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-[2px]"
              style={{ color: 'var(--text-muted)', marginRight: 4 }}>
              Statut
            </span>
            <StatusChip
              label="Tout" count={cards.length}
              active={filter == null} onClick={() => setFilter(null)}
              color="var(--scarlet)"
            />
            {statuses.map(s => (
              <StatusChip
                key={s.key}
                label={s.label} color={s.color}
                count={statusCounts[s.key] || 0}
                active={filter === s.key}
                onClick={() => setFilter(filter === s.key ? null : s.key)}
                onDelete={!s.builtin && s.id ? () => deleteStatus(s.id!) : undefined}
              />
            ))}
            <button onClick={() => setShowStatusModal(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors"
              style={{
                background: 'transparent',
                border: '1px dashed var(--border)',
                color: 'var(--text-muted)',
              }}
              onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--scarlet)'; e.currentTarget.style.color = 'var(--scarlet)' }}
              onMouseOut={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}>
              <Plus className="w-3 h-3" /> Nouvel état
            </button>
          </div>
        )}

        {/* ── Filter bar (tags) — affichée si au moins un tag existe ── */}
        {activeProject && allTags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-[2px]"
              style={{ color: 'var(--text-muted)', marginRight: 4 }}>
              Tags
            </span>
            {allTags.map(t => {
              const active = tagFilter.some(x => x.toLowerCase() === t.label.toLowerCase())
              const c = colorForTag(t.label)
              return (
                <button
                  key={t.label}
                  onClick={() => setTagFilter(prev => active
                    ? prev.filter(x => x.toLowerCase() !== t.label.toLowerCase())
                    : [...prev, t.label])}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors"
                  style={{
                    background: active ? `color-mix(in srgb, ${c} 18%, transparent)` : 'var(--bg-secondary)',
                    border: `1px solid ${active ? `color-mix(in srgb, ${c} 50%, transparent)` : 'var(--border)'}`,
                    color: active ? c : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
                  {t.label}
                  <span style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                    color: 'var(--text-muted)', padding: '0 4px',
                    background: 'var(--bg-primary)', borderRadius: 4,
                  }}>{t.count}</span>
                </button>
              )
            })}
            {tagFilter.length > 0 && (
              <button onClick={() => setTagFilter([])}
                className="text-[10px] font-medium px-2 py-1 rounded-lg transition-colors"
                style={{ color: 'var(--text-muted)', background: 'transparent', border: 'none' }}>
                Effacer les filtres tags
              </button>
            )}
          </div>
        )}

        {/* ── Grid board ───────────────────────────────────────── */}
        {activeProject && (
          <div className="rounded-xl p-4" style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            minHeight: 480, position: 'relative',
            backgroundImage: `
              linear-gradient(color-mix(in srgb, var(--scarlet) 3%, transparent) 1px, transparent 1px),
              linear-gradient(90deg, color-mix(in srgb, var(--scarlet) 3%, transparent) 1px, transparent 1px)
            `,
            backgroundSize: '274px 274px',
            backgroundPosition: '16px 16px',
          }}>
            {visibleCards.length === 0 && (searchQuery || tagFilter.length > 0 || filter != null) ? (
              <div className="flex items-center justify-center h-96 text-sm" style={{ color: 'var(--text-muted)' }}>
                Aucune carte ne correspond aux filtres.
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gridAutoRows: 260,
                gap: 14,
              }}>
                {visibleCards.map((card, idx) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    status={getStatus(card.status_key)}
                    statuses={statuses}
                    allTags={allTags}
                    isDragged={draggedId === card.id}
                    isDropTarget={dropTargetIdx === idx}
                    onDragStart={e => handleDragStart(e, card.id)}
                    onDragOver={e => handleDragOver(e, idx)}
                    onDrop={e => handleDrop(e, idx)}
                    onDragEnd={handleDragEnd}
                    onUpdate={updates => updateCard(card.id, updates)}
                    onDelete={() => deleteCard(card.id)}
                  />
                ))}
                {/* Emplacements vides avec "+" — ajouter une carte à la volée.
                    On ajoute plusieurs slots pour combler visuellement la grille
                    même quand elle est quasi-pleine. N'apparaît pas quand un
                    filtre est actif (la grille est "filtrée", pas vide). */}
                {filter == null && !searchQuery && tagFilter.length === 0 && (
                  Array.from({ length: Math.max(3, 8 - visibleCards.length % 8) }).map((_, i) => (
                    <EmptySlot
                      key={`empty-${i}`}
                      onCreate={async () => {
                        if (!activeProjectId) return
                        try {
                          const r = await jsend<{ card: CardT }>(
                            `${API}/projects/${activeProjectId}/cards`, 'POST',
                            { title: 'Nouvelle carte', status_key: newCardStatus,
                              position: cards.length + i, expanded: true }
                          )
                          setCards(prev => [...prev, r.card])
                        } catch (err) { console.warn('create from slot failed:', err) }
                      }}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )}

      </div>

      {/* ── Status creation modal ─────────────────────────────── */}
      {showStatusModal && (
        <StatusModal
          palette={palette}
          onCancel={() => setShowStatusModal(false)}
          onCreate={createStatus}
        />
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// StatusChip — filter pill
// ════════════════════════════════════════════════════════════════════════

function StatusChip({
  label, color, count, active, onClick, onDelete,
}: {
  label: string
  color: string
  count: number
  active: boolean
  onClick: () => void
  onDelete?: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors cursor-pointer"
      style={{
        background: active ? 'color-mix(in srgb, var(--scarlet) 10%, transparent)' : 'var(--bg-secondary)',
        border: `1px solid ${active ? 'color-mix(in srgb, var(--scarlet) 35%, transparent)' : 'var(--border)'}`,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: color, boxShadow: `0 0 6px ${color}`,
      }} />
      <span>{label}</span>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
        color: 'var(--text-muted)', padding: '0 5px',
        background: 'var(--bg-primary)', borderRadius: 4,
      }}>{count}</span>
      {onDelete && hover && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{
            background: 'none', border: 'none', padding: 0,
            color: 'var(--text-muted)', cursor: 'pointer',
            display: 'flex', alignItems: 'center',
          }}
          onMouseOver={e => (e.currentTarget.style.color = '#ef4444')}
          onMouseOut={e => (e.currentTarget.style.color = 'var(--text-muted)')}
          title="Supprimer ce statut">
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// CardTile
// ════════════════════════════════════════════════════════════════════════

function CardTile({
  card, status, statuses, allTags, isDragged, isDropTarget,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onUpdate, onDelete,
}: {
  card: CardT
  status: StatusT
  statuses: StatusT[]
  allTags: TagEntryT[]
  isDragged: boolean
  isDropTarget: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onUpdate: (updates: Partial<CardT>) => void
  onDelete: () => void
}) {
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [newSubtaskLabel, setNewSubtaskLabel] = useState('')
  const [newSubtask2Label, setNewSubtask2Label] = useState('')

  // Agrégé des 2 listes pour la barre globale en bas
  const allSubs = [...(card.subtasks || []), ...(card.subtasks2 || [])]
  const doneCount = allSubs.filter(s => s.done).length
  const totalSubtasks = allSubs.length
  const progress = totalSubtasks > 0 ? doneCount / totalSubtasks : 0

  const toggleExpanded = () => onUpdate({ expanded: !card.expanded })

  const setStatus = (key: string) => {
    setStatusMenuOpen(false)
    onUpdate({ status_key: key })
  }

  // Helpers génériques pour les 2 listes — `which` choisit quel champ update
  const toggleSubtask = (sid: string, which: 1 | 2 = 1) => {
    const src = which === 1 ? card.subtasks : card.subtasks2
    const next = src.map(s => s.id === sid ? { ...s, done: !s.done } : s)
    onUpdate(which === 1 ? { subtasks: next } : { subtasks2: next })
  }
  const renameSubtask = (sid: string, label: string, which: 1 | 2 = 1) => {
    const src = which === 1 ? card.subtasks : card.subtasks2
    const cleaned = label.trim()
    if (!cleaned) return
    const next = src.map(s => s.id === sid ? { ...s, label: cleaned } : s)
    onUpdate(which === 1 ? { subtasks: next } : { subtasks2: next })
  }
  const addSubtask = (which: 1 | 2 = 1) => {
    const label = (which === 1 ? newSubtaskLabel : newSubtask2Label).trim()
    if (!label) return
    const src = which === 1 ? card.subtasks : card.subtasks2
    const next = [...src, { id: newSubtaskId(), label, done: false }]
    onUpdate(which === 1 ? { subtasks: next } : { subtasks2: next })
    if (which === 1) setNewSubtaskLabel(''); else setNewSubtask2Label('')
  }
  const removeSubtask = (sid: string, which: 1 | 2 = 1) => {
    const src = which === 1 ? card.subtasks : card.subtasks2
    onUpdate(which === 1
      ? { subtasks: src.filter(s => s.id !== sid) }
      : { subtasks2: src.filter(s => s.id !== sid) })
  }

  const addTag = (label: string) => {
    const cleaned = label.trim().slice(0, 40)
    if (!cleaned) return
    if ((card.tags || []).some(t => t.toLowerCase() === cleaned.toLowerCase())) return
    onUpdate({ tags: [...(card.tags || []), cleaned] })
  }
  const removeTag = (label: string) => {
    onUpdate({ tags: (card.tags || []).filter(t => t !== label) })
  }

  return (
    <div
      draggable={!card.expanded}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        gridColumn: card.expanded ? 'span 2' : undefined,
        gridRow: card.expanded ? 'span 2' : undefined,
        background: 'var(--bg-tertiary)',
        border: `1px solid ${card.expanded
          ? 'color-mix(in srgb, var(--scarlet) 35%, var(--border))'
          : isDropTarget ? 'var(--scarlet)' : 'var(--border)'}`,
        borderRadius: 12,
        overflow: 'hidden',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s, opacity 0.15s',
        cursor: card.expanded ? 'default' : 'grab',
        opacity: isDragged ? 0.3 : 1,
        boxShadow: card.expanded
          ? '0 12px 40px rgba(0,0,0,0.4), 0 0 0 1px color-mix(in srgb, var(--scarlet) 10%, transparent)'
          : isDropTarget ? '0 0 0 2px var(--scarlet)' : 'none',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: 12,
        borderBottom: card.expanded ? '1px solid var(--border)' : 'none',
      }}>
        <button
          onClick={toggleExpanded}
          style={{
            background: 'transparent', border: 'none', padding: 2,
            color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0,
            transition: 'transform 0.15s',
            transform: card.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
          title={card.expanded ? 'Replier' : 'Déplier'}>
          <ChevronRight className="w-4 h-4" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          {card.expanded ? (
            <>
              <EditableText
                value={card.title}
                onSave={v => onUpdate({ title: v })}
                className="text-sm font-semibold"
                style={{ color: 'var(--text-primary)', lineHeight: 1.35 }}
                singleLine
              />
              <EditableText
                value={card.subtitle}
                onSave={v => onUpdate({ subtitle: v })}
                placeholder="Sous-titre (optionnel)…"
                className="text-[11px] mt-0.5"
                style={{ color: 'var(--text-muted)', lineHeight: 1.35, fontStyle: 'italic' }}
                singleLine
              />
            </>
          ) : (
            <>
              <div className="text-sm font-semibold" style={{
                color: 'var(--text-primary)', lineHeight: 1.35,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {card.title || 'Sans titre'}
              </div>
              {card.subtitle && (
                <div className="text-[11px] mt-0.5" style={{
                  color: 'var(--text-muted)', lineHeight: 1.3, fontStyle: 'italic',
                  display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {card.subtitle}
                </div>
              )}
            </>
          )}
        </div>
        {/* Status badge (top-right) */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setStatusMenuOpen(v => !v)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 8px', borderRadius: 4,
              background: `color-mix(in srgb, ${status.color} 15%, transparent)`,
              border: `1px solid color-mix(in srgb, ${status.color} 35%, transparent)`,
              color: status.color, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            }}
            title="Changer de statut">
            <span style={{
              width: 5, height: 5, borderRadius: '50%', background: status.color,
            }} />
            {status.label}
          </button>
          {statusMenuOpen && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 4px)',
              minWidth: 160, background: 'var(--bg-secondary)',
              border: '1px solid var(--border)', borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 5, padding: 4,
            }}>
              {statuses.map(s => (
                <button key={s.key}
                  onClick={() => setStatus(s.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', textAlign: 'left',
                    padding: '5px 8px', borderRadius: 6,
                    background: s.key === card.status_key ? 'var(--bg-tertiary)' : 'transparent',
                    color: 'var(--text-primary)', border: 'none', cursor: 'pointer', fontSize: 11,
                  }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color }} />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: 12, paddingTop: card.expanded ? 10 : 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {card.expanded ? (
          <>
            {/* Tags (gérables dans le mode déplié) */}
            <TagBar
              tags={card.tags || []}
              suggestions={allTags}
              onAdd={addTag}
              onRemove={removeTag}
            />

            {/* Description éditable */}
            <EditableText
              value={card.description}
              onSave={v => onUpdate({ description: v })}
              placeholder="Description (clique pour éditer)…"
              className="text-xs"
              style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
            />

            {/* Zone sous-tâches scrollable : 2 listes côte à côte ou empilées */}
            <div style={{ flex: 1, overflowY: 'auto', marginTop: 4, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SubtaskList
                label="Sous-tâches"
                items={card.subtasks || []}
                newLabel={newSubtaskLabel}
                setNewLabel={setNewSubtaskLabel}
                onToggle={sid => toggleSubtask(sid, 1)}
                onRename={(sid, label) => renameSubtask(sid, label, 1)}
                onAdd={() => addSubtask(1)}
                onRemove={sid => removeSubtask(sid, 1)}
              />
              <SubtaskList
                label={card.subtasks2_title || 'Seconde liste'}
                items={card.subtasks2 || []}
                newLabel={newSubtask2Label}
                setNewLabel={setNewSubtask2Label}
                onToggle={sid => toggleSubtask(sid, 2)}
                onRename={(sid, label) => renameSubtask(sid, label, 2)}
                onAdd={() => addSubtask(2)}
                onRemove={sid => removeSubtask(sid, 2)}
                editableLabel
                onLabelChange={v => onUpdate({ subtasks2_title: v.slice(0, 60) })}
              />
            </div>

            {/* Progress bar agrégée (placée en bas comme demandé) */}
            {totalSubtasks > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                paddingTop: 6,
                fontSize: 10, color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                <span>{doneCount}/{totalSubtasks}</span>
                <div style={{
                  flex: 1, height: 3, borderRadius: 2, background: 'var(--bg-primary)', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', width: `${progress * 100}%`,
                    background: 'var(--scarlet)', transition: 'width 0.2s',
                  }} />
                </div>
                <span style={{ opacity: 0.6 }}>{Math.round(progress * 100)}%</span>
              </div>
            )}

            {/* Footer actions */}
            <div style={{
              display: 'flex', justifyContent: 'flex-end', paddingTop: 6,
              borderTop: '1px solid var(--border)',
            }}>
              <button onClick={onDelete}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 6,
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-muted)', fontSize: 10, cursor: 'pointer',
                }}
                onMouseOver={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.borderColor = '#ef4444' }}
                onMouseOut={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)' }}>
                <Trash2 className="w-3 h-3" /> Supprimer
              </button>
            </div>
          </>
        ) : (
          <>
            {card.description && (
              <div className="text-[11px]" style={{
                color: 'var(--text-muted)', lineHeight: 1.4,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {card.description}
              </div>
            )}
            {/* Tags repliés — max 3 visibles + compteur "+N" */}
            {(card.tags || []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 'auto' }}>
                {(card.tags || []).slice(0, 3).map(t => {
                  const c = colorForTag(t)
                  return (
                    <span key={t} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                      padding: '1px 6px', borderRadius: 4,
                      background: `color-mix(in srgb, ${c} 15%, transparent)`,
                      color: c, fontSize: 9.5, fontWeight: 600,
                    }}>
                      <span style={{ width: 4, height: 4, borderRadius: '50%', background: c }} />
                      {t}
                    </span>
                  )
                })}
                {(card.tags || []).length > 3 && (
                  <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                    +{(card.tags || []).length - 3}
                  </span>
                )}
              </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4, opacity: 0.5,
              marginTop: (card.tags || []).length > 0 ? undefined : 'auto',
            }}>
              <GripVertical className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                glisser pour déplacer
              </span>
            </div>
            {/* Progress bar tout en bas de la carte repliée */}
            {totalSubtasks > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 10, color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                paddingTop: 6, borderTop: '1px solid var(--border)',
              }}>
                <span>{doneCount}/{totalSubtasks}</span>
                <div style={{
                  flex: 1, height: 2, borderRadius: 1, background: 'var(--bg-primary)', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', width: `${progress * 100}%`,
                    background: 'var(--scarlet)',
                  }} />
                </div>
                <span style={{ opacity: 0.7 }}>{Math.round(progress * 100)}%</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// SubtaskList — liste cochable + édition inline du label
// ════════════════════════════════════════════════════════════════════════

function SubtaskList({
  label, items, newLabel, setNewLabel,
  onToggle, onRename, onAdd, onRemove,
  editableLabel, onLabelChange,
}: {
  label: string
  items: SubtaskT[]
  newLabel: string
  setNewLabel: (v: string) => void
  onToggle: (sid: string) => void
  onRename: (sid: string, label: string) => void
  onAdd: () => void
  onRemove: (sid: string) => void
  editableLabel?: boolean
  onLabelChange?: (v: string) => void
}) {
  return (
    <div>
      {(items.length > 0 || editableLabel) && (
        editableLabel && onLabelChange ? (
          <EditableHeader value={label} onSave={onLabelChange} />
        ) : (
          <div className="text-[9px] font-mono uppercase tracking-[2px] mb-1"
            style={{ color: 'var(--text-muted)' }}>
            {label}
          </div>
        )
      )}
      {items.map(st => (
        <div key={st.id} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 0', fontSize: 12,
        }}>
          <button onClick={() => onToggle(st.id)}
            style={{
              flexShrink: 0, width: 14, height: 14,
              borderRadius: 4, border: `1.5px solid ${st.done ? 'var(--scarlet)' : 'var(--border)'}`,
              background: st.done ? 'var(--scarlet)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', padding: 0,
            }}>
            {st.done && <Check className="w-2.5 h-2.5" style={{ color: '#fff' }} strokeWidth={3} />}
          </button>
          {/* Label éditable — click pour entrer en édition (même quand done) */}
          <InlineEditableLabel
            value={st.label}
            done={st.done}
            onSave={v => onRename(st.id, v)}
          />
          <button onClick={() => onRemove(st.id)}
            style={{
              background: 'none', border: 'none', padding: 2, cursor: 'pointer',
              color: 'var(--text-muted)', opacity: 0.5, flexShrink: 0,
            }}
            onMouseOver={e => (e.currentTarget.style.opacity = '1')}
            onMouseOut={e => (e.currentTarget.style.opacity = '0.5')}
            title="Supprimer">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 0', marginTop: 4,
      }}>
        <Plus className="w-3 h-3" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
          onBlur={() => newLabel.trim() && onAdd()}
          placeholder={items.length === 0 ? `Nouvelle ${label.toLowerCase()}…` : 'Ajouter…'}
          style={{
            flex: 1, background: 'transparent', border: 'none',
            fontSize: 11.5, color: 'var(--text-primary)', outline: 'none',
          }}
        />
      </div>
    </div>
  )
}

// Label de sous-tâche éditable : click → input, blur/Enter save, Escape cancel
function InlineEditableLabel({
  value, done, onSave,
}: { value: string; done: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => setDraft(value), [value])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft !== value && draft.trim()) onSave(draft) }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        style={{
          flex: 1, background: 'var(--bg-primary)',
          border: '1px solid color-mix(in srgb, var(--scarlet) 35%, var(--border))',
          borderRadius: 4, padding: '2px 6px',
          fontSize: 11.5, color: 'var(--text-primary)', outline: 'none',
        }}
      />
    )
  }
  return (
    <span
      onClick={() => setEditing(true)}
      style={{
        flex: 1,
        textDecoration: done ? 'line-through' : 'none',
        color: done ? 'var(--text-muted)' : 'var(--text-primary)',
        cursor: 'text',
        padding: '1px 2px',
        borderRadius: 3,
      }}
      title="Cliquer pour éditer"
    >
      {value}
    </span>
  )
}

// En-tête éditable d'une liste : clic sur le titre → input.
function EditableHeader({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => setDraft(value), [value])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])
  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        maxLength={60}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft.trim() && draft !== value) onSave(draft.trim()) }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        className="text-[9px] font-mono uppercase tracking-[2px] mb-1"
        style={{
          width: '100%',
          background: 'var(--bg-primary)',
          border: '1px solid color-mix(in srgb, var(--scarlet) 35%, var(--border))',
          borderRadius: 4, padding: '2px 6px',
          color: 'var(--text-primary)', outline: 'none',
        }}
      />
    )
  }
  return (
    <div
      onClick={() => setEditing(true)}
      className="text-[9px] font-mono uppercase tracking-[2px] mb-1"
      style={{ color: 'var(--text-muted)', cursor: 'text' }}
      title="Cliquer pour renommer"
    >
      {value}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// TagBar — chips + input avec autocomplete depuis tous les tags user
// ════════════════════════════════════════════════════════════════════════

function TagBar({
  tags, suggestions, onAdd, onRemove,
}: {
  tags: string[]
  suggestions: TagEntryT[]
  onAdd: (label: string) => void
  onRemove: (label: string) => void
}) {
  const [input, setInput] = useState('')
  const [showSuggest, setShowSuggest] = useState(false)
  const currentLower = tags.map(t => t.toLowerCase())
  const filtered = suggestions
    .filter(s => !currentLower.includes(s.label.toLowerCase()))
    .filter(s => !input || s.label.toLowerCase().includes(input.toLowerCase()))
    .slice(0, 8)

  const commit = (label: string) => {
    const v = label.trim()
    if (!v) return
    onAdd(v)
    setInput('')
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <TagIcon className="w-3 h-3" style={{ color: 'var(--text-muted)', marginRight: 2 }} />
      {tags.map(t => {
        const c = colorForTag(t)
        return (
          <span key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 6px 2px 8px', borderRadius: 4,
            background: `color-mix(in srgb, ${c} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
            color: c, fontSize: 10, fontWeight: 600,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />
            {t}
            <button onClick={() => onRemove(t)}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'inherit', display: 'flex', alignItems: 'center',
              }} title="Retirer">
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        )
      })}
      <div style={{ position: 'relative' }}>
        <input
          value={input}
          onChange={e => { setInput(e.target.value); setShowSuggest(true) }}
          onFocus={() => setShowSuggest(true)}
          onBlur={() => setTimeout(() => setShowSuggest(false), 120)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(input) }
            if (e.key === 'Escape') { setInput(''); setShowSuggest(false) }
          }}
          placeholder="+ tag"
          style={{
            background: 'transparent', border: '1px dashed var(--border)',
            borderRadius: 4, padding: '1px 6px', fontSize: 10,
            color: 'var(--text-muted)', outline: 'none', width: 70,
          }}
        />
        {showSuggest && filtered.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0,
            minWidth: 140, maxWidth: 200,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 6, boxShadow: '0 8px 18px rgba(0,0,0,0.3)',
            padding: 3, zIndex: 10, maxHeight: 160, overflowY: 'auto',
          }}>
            {filtered.map(s => {
              const c = colorForTag(s.label)
              return (
                <button key={s.label}
                  onMouseDown={e => { e.preventDefault(); commit(s.label) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    width: '100%', padding: '4px 6px',
                    borderRadius: 4, background: 'transparent', border: 'none',
                    color: 'var(--text-primary)', fontSize: 11, cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
                  <span style={{ flex: 1 }}>{s.label}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>×{s.count}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// EmptySlot — cellule "+" cliquable pour créer une carte à la volée
// ════════════════════════════════════════════════════════════════════════

function EmptySlot({ onCreate }: { onCreate: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onCreate}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        gridColumn: 'span 1', gridRow: 'span 1',
        background: hover ? 'color-mix(in srgb, var(--scarlet) 4%, transparent)' : 'transparent',
        border: `1px dashed ${hover ? 'color-mix(in srgb, var(--scarlet) 50%, transparent)' : 'var(--border)'}`,
        borderRadius: 12,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 6, cursor: 'pointer',
        transition: 'all 0.15s', padding: 0,
      }}
      title="Créer une carte ici">
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover
          ? 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))'
          : 'var(--bg-primary)',
        border: `1px solid ${hover ? 'transparent' : 'var(--border)'}`,
        color: hover ? '#fff' : 'var(--text-muted)',
      }}>
        <Plus className="w-4 h-4" />
      </div>
      <span style={{
        fontSize: 10, color: hover ? 'var(--scarlet)' : 'var(--text-muted)',
        fontWeight: 500,
      }}>
        {hover ? 'Créer ici' : 'Emplacement libre'}
      </span>
    </button>
  )
}

// ════════════════════════════════════════════════════════════════════════
// ExportMenu — 5 formats (JSON, Markdown, CSV, PDF, HTML)
// ════════════════════════════════════════════════════════════════════════

function ExportMenu({
  project, cards, statuses, open, onToggle, onClose,
}: {
  project: ProjectT
  cards: CardT[]
  statuses: StatusT[]
  open: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  const pick = (fmt: 'json' | 'md' | 'csv' | 'pdf' | 'html') => {
    onClose()
    const stamp = new Date().toISOString().slice(0, 10)
    const slug = (project.title || 'valkyrie').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'projet'
    const fname = `valkyrie-${slug}-${stamp}`
    if (fmt === 'json') downloadBlob(buildJson(project, cards, statuses), `${fname}.json`, 'application/json')
    if (fmt === 'md')   downloadBlob(buildMarkdown(project, cards, statuses), `${fname}.md`, 'text/markdown;charset=utf-8')
    if (fmt === 'csv')  downloadBlob(buildCsv(project, cards, statuses), `${fname}.csv`, 'text/csv;charset=utf-8')
    if (fmt === 'html') downloadBlob(buildHtml(project, cards, statuses, false), `${fname}.html`, 'text/html;charset=utf-8')
    if (fmt === 'pdf')  openPrintPdf(buildHtml(project, cards, statuses, true))
  }

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={onToggle}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        title="Exporter le projet">
        <Download className="w-3.5 h-3.5" /> Exporter ▾
      </button>
      {open && (
        <div role="menu" style={{
          position: 'absolute', right: 0, top: 'calc(100% + 4px)',
          minWidth: 220, background: 'var(--bg-secondary)',
          border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)', zIndex: 20, padding: 4,
        }}>
          {([
            ['pdf',  'PDF',      'Impression navigateur → PDF'],
            ['html', 'HTML',     'Page web autonome stylée'],
            ['md',   'Markdown', 'Pour Notion, Obsidian…'],
            ['json', 'JSON',     'Données brutes complètes'],
            ['csv',  'CSV',      'Excel / Google Sheets'],
          ] as const).map(([k, lbl, desc]) => (
            <button key={k}
              onClick={() => pick(k as any)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', borderRadius: 6,
                background: 'transparent', border: 'none',
                color: 'var(--text-primary)', cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{lbl}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Export builders ─────────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function openPrintPdf(html: string) {
  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) { alert('Popup bloquée. Autorise les popups pour exporter en PDF.'); return }
  w.document.open()
  w.document.write(html.replace('</body></html>',
    '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),250));<\/script></body></html>'))
  w.document.close()
}

function buildJson(project: ProjectT, cards: CardT[], statuses: StatusT[]): string {
  return JSON.stringify({
    plugin: 'valkyrie',
    generated_at: new Date().toISOString(),
    project,
    statuses,
    cards: cards.map(c => ({ ...c })),
  }, null, 2)
}

function buildMarkdown(project: ProjectT, cards: CardT[], statuses: StatusT[]): string {
  const statusLabel = (key: string) => statuses.find(s => s.key === key)?.label || key
  const lines: string[] = []
  lines.push(`# ${project.title}`)
  if (project.description) lines.push('', project.description)
  lines.push('', `> Export Valkyrie — ${new Date().toLocaleString('fr-FR')} · ${cards.length} carte${cards.length > 1 ? 's' : ''}`)
  // Grouper par statut pour la lisibilité
  const byStatus: Record<string, CardT[]> = {}
  for (const c of cards) (byStatus[c.status_key] ||= []).push(c)
  for (const st of statuses) {
    const group = byStatus[st.key] || []
    if (!group.length) continue
    lines.push('', `## ${st.label} (${group.length})`)
    for (const c of group) {
      lines.push('', `### ${c.title || '(sans titre)'}`)
      if (c.subtitle) lines.push(`_${c.subtitle}_`)
      if ((c.tags || []).length) lines.push(`**Tags :** ${c.tags.map(t => `\`${t}\``).join(' ')}`)
      if (c.description) lines.push('', c.description)
      const dumpList = (label: string, arr: SubtaskT[]) => {
        if (!arr.length) return
        lines.push('', `**${label}**`)
        for (const s of arr) lines.push(`- [${s.done ? 'x' : ' '}] ${s.label}`)
      }
      dumpList('Sous-tâches', c.subtasks || [])
      dumpList(c.subtasks2_title || 'Seconde liste', c.subtasks2 || [])
    }
  }
  return lines.join('\n') + '\n'
}

function buildCsv(project: ProjectT, cards: CardT[], statuses: StatusT[]): string {
  const statusLabel = (key: string) => statuses.find(s => s.key === key)?.label || key
  const esc = (v: any) => {
    const s = String(v ?? '')
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const header = ['id', 'title', 'subtitle', 'status', 'description', 'tags',
                  'subtasks1_done', 'subtasks1_total',
                  'subtasks2_done', 'subtasks2_total',
                  'created_at', 'updated_at'].join(',')
  const rows = cards.map(c => [
    c.id, c.title, c.subtitle || '', statusLabel(c.status_key),
    (c.description || '').replace(/\n/g, ' '),
    (c.tags || []).join('|'),
    (c.subtasks || []).filter(s => s.done).length, (c.subtasks || []).length,
    (c.subtasks2 || []).filter(s => s.done).length, (c.subtasks2 || []).length,
    c.created_at || '', c.updated_at || '',
  ].map(esc).join(','))
  return `# Valkyrie — ${project.title}\n${header}\n${rows.join('\n')}\n`
}

function buildHtml(project: ProjectT, cards: CardT[], statuses: StatusT[], forPdf: boolean): string {
  const esc = (s: string) => (s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' } as any)[c])
  const statusLabel = (key: string) => statuses.find(s => s.key === key)?.label || key
  const statusColor = (key: string) => statuses.find(s => s.key === key)?.color || '#7a8a9b'

  // PDF : variant "light" lisible à l'impression (les navigateurs coupent les
  // bg sombres par défaut). HTML download : variant "dark" ScarletWolf.
  const dark = !forPdf
  const css = dark ? `
    body { font-family: 'Inter', system-ui, sans-serif; color: #f5f5f5; background: #080808; line-height: 1.6; max-width: 820px; margin: 0 auto; padding: 32px 28px; }
    header { border-bottom: 3px solid #dc2626; padding-bottom: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
    h1 .r { color: #ef4444; text-shadow: 0 0 12px rgba(220,38,38,0.4); }
    .desc { color: #a3a3a3; margin-top: 6px; }
    .meta { color: #666; font-size: 11px; font-variant: all-small-caps; letter-spacing: 0.05em; margin-top: 8px; }
    h2 { color: #f5f5f5; border-bottom: 1px solid rgba(220,38,38,0.3); padding-bottom: 4px; margin-top: 26px; }
    .card { background: #131313; border-left: 3px solid #dc2626; border-radius: 6px; padding: 12px 14px; margin: 10px 0; }
    .card h3 { margin: 0 0 2px; font-size: 15px; color: #f5f5f5; }
    .card .sub { color: #a3a3a3; font-style: italic; font-size: 12px; margin-bottom: 6px; }
    .badge { display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 4px; margin-right: 4px; }
    .tag { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 4px; margin: 0 3px 3px 0; }
    .list { margin: 8px 0 4px; padding-left: 18px; color: #d4d4d4; font-size: 13px; }
    .list li { list-style: none; margin: 2px 0; }
    .list li.done { color: #666; text-decoration: line-through; }
    .list li::before { content: '☐'; margin-right: 6px; color: #737373; }
    .list li.done::before { content: '☑'; color: #10b981; }
    .list-title { font-size: 10px; font-family: 'JetBrains Mono', monospace; color: #737373; text-transform: uppercase; letter-spacing: 2px; margin-top: 8px; }
    footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #2a2a2a; font-size: 10px; color: #666; text-align: center; }
  ` : `
    @page { margin: 18mm; }
    body { font-family: 'Inter', system-ui, sans-serif; color: #1c1c1c; background: #faf7f2; line-height: 1.55; max-width: 780px; margin: 0 auto; padding: 24px; }
    header { border-bottom: 3px solid #dc2626; padding-bottom: 12px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 24px; }
    h1 .r { color: #dc2626; }
    .desc { color: #4a3f35; margin-top: 4px; font-size: 13px; }
    .meta { color: #8a7a6a; font-size: 10.5px; font-variant: all-small-caps; letter-spacing: 0.04em; margin-top: 6px; }
    h2 { color: #1c1c1c; border-bottom: 1px solid rgba(220,38,38,0.25); padding-bottom: 4px; margin-top: 22px; }
    .card { background: #f0eadf; border-left: 3px solid #dc2626; border-radius: 4px; padding: 10px 12px; margin: 8px 0; break-inside: avoid; }
    .card h3 { margin: 0 0 2px; font-size: 14px; }
    .card .sub { color: #4a3f35; font-style: italic; font-size: 11.5px; margin-bottom: 4px; }
    .badge { display: inline-block; font-size: 9.5px; padding: 1px 6px; border-radius: 4px; margin-right: 3px; }
    .tag { display: inline-block; font-size: 9.5px; padding: 1px 6px; border-radius: 4px; margin: 0 3px 3px 0; }
    .list { margin: 6px 0 4px; padding-left: 16px; color: #2b2620; font-size: 12px; }
    .list li { list-style: none; margin: 1px 0; }
    .list li.done { color: #8a7a6a; text-decoration: line-through; }
    .list li::before { content: '☐'; margin-right: 6px; color: #8a7a6a; }
    .list li.done::before { content: '☑'; color: #7a1010; }
    .list-title { font-size: 9.5px; font-family: 'JetBrains Mono', monospace; color: #8a7a6a; text-transform: uppercase; letter-spacing: 2px; margin-top: 6px; }
    footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #ddd5c8; font-size: 10px; color: #8a7a6a; text-align: center; }
  `

  const renderCard = (c: CardT) => {
    const color = statusColor(c.status_key)
    const tags = (c.tags || []).map(t => `<span class="tag" style="background:color-mix(in srgb, ${colorForTag(t)} 15%, transparent); color:${colorForTag(t)}">${esc(t)}</span>`).join('')
    const list = (items: SubtaskT[]) => items.length
      ? `<ul class="list">${items.map(s => `<li class="${s.done ? 'done' : ''}">${esc(s.label)}</li>`).join('')}</ul>`
      : ''
    return `
      <div class="card">
        <span class="badge" style="background:color-mix(in srgb, ${color} 15%, transparent); color:${color}">
          ${esc(statusLabel(c.status_key))}
        </span>
        ${tags}
        <h3>${esc(c.title) || '(sans titre)'}</h3>
        ${c.subtitle ? `<div class="sub">${esc(c.subtitle)}</div>` : ''}
        ${c.description ? `<p>${esc(c.description).replace(/\n/g, '<br>')}</p>` : ''}
        ${(c.subtasks || []).length ? `<div class="list-title">Sous-tâches</div>${list(c.subtasks)}` : ''}
        ${(c.subtasks2 || []).length ? `<div class="list-title">${esc(c.subtasks2_title || 'Seconde liste')}</div>${list(c.subtasks2)}` : ''}
      </div>`
  }

  // Grouper par statut
  const byStatus: Record<string, CardT[]> = {}
  for (const c of cards) (byStatus[c.status_key] ||= []).push(c)
  const sections = statuses
    .map(st => {
      const group = byStatus[st.key] || []
      if (!group.length) return ''
      return `<h2>${esc(st.label)} <span style="font-size:12px; color:${dark ? '#666' : '#8a7a6a'}">(${group.length})</span></h2>${group.map(renderCard).join('')}`
    })
    .join('')

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Valkyrie — ${esc(project.title)}</title>
<style>${css}</style></head><body>
<header>
  <h1>Valkyri<span class="r">e</span></h1>
  <div class="desc"><strong>${esc(project.title)}</strong>${project.description ? ` — ${esc(project.description)}` : ''}</div>
  <div class="meta">Export ${new Date().toLocaleString('fr-FR')} · ${cards.length} carte${cards.length > 1 ? 's' : ''}</div>
</header>
<main>${sections || '<p style="color:#666">Aucune carte.</p>'}</main>
<footer>Généré par Valkyrie — plugin Gungnir ScarletWolf</footer>
</body></html>`
}

// ════════════════════════════════════════════════════════════════════════
// EditableText — double-click to edit, blur / Enter to save
// ════════════════════════════════════════════════════════════════════════

function EditableText({
  value, onSave, placeholder, className, style, singleLine,
}: {
  value: string
  onSave: (v: string) => void
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  singleLine?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      if ('select' in ref.current) ref.current.select()
    }
  }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }

  if (editing) {
    const common = {
      value: draft,
      onChange: (e: any) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        if (singleLine && e.key === 'Enter') { e.preventDefault(); commit() }
        if (!singleLine && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit() }
      },
      className,
      style: {
        ...style,
        width: '100%',
        background: 'var(--bg-primary)',
        border: '1px solid color-mix(in srgb, var(--scarlet) 35%, var(--border))',
        borderRadius: 8,
        padding: '4px 8px',
        outline: 'none',
        resize: 'none' as const,
      },
    }
    return singleLine
      ? <input ref={ref as any} {...common} />
      : <textarea ref={ref as any} {...common} rows={3} />
  }

  const showPlaceholder = !value && placeholder
  return (
    <div
      onClick={() => setEditing(true)}
      className={className}
      style={{
        ...style,
        cursor: 'text',
        color: showPlaceholder ? 'var(--text-muted)' : style?.color,
        fontStyle: showPlaceholder ? 'italic' : undefined,
        whiteSpace: singleLine ? 'nowrap' : 'pre-wrap',
        overflow: singleLine ? 'hidden' : undefined,
        textOverflow: singleLine ? 'ellipsis' : undefined,
        padding: '2px 4px',
        margin: '0 -4px',
        borderRadius: 4,
        transition: 'background 0.15s',
      }}
      onMouseOver={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--scarlet) 4%, transparent)' }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
      title="Cliquer pour éditer"
    >
      {value || placeholder || ' '}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════
// Status creation modal
// ════════════════════════════════════════════════════════════════════════

function StatusModal({
  palette, onCancel, onCreate,
}: {
  palette: string[]
  onCancel: () => void
  onCreate: (label: string, color: string) => void
}) {
  const [label, setLabel] = useState('')
  const [color, setColor] = useState(palette[0] || '#dc2626')

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 50, padding: 16,
      }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420, padding: 20, borderRadius: 12,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}>
        <h3 className="text-base font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Nouvel état</h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Crée un état personnalisé pour tes cartes (ex : en pause, à valider, bloqué…)
        </p>

        <label className="text-[10px] font-mono uppercase tracking-[2px] block mb-1" style={{ color: 'var(--text-muted)' }}>Nom</label>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Ex : En pause"
          maxLength={24}
          autoFocus
          className="w-full px-3 py-2 rounded-lg text-sm outline-none mb-4"
          style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            color: 'var(--text-primary)',
          }}
        />

        <label className="text-[10px] font-mono uppercase tracking-[2px] block mb-2" style={{ color: 'var(--text-muted)' }}>Couleur</label>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginBottom: 16,
        }}>
          {palette.map(c => (
            <button key={c}
              onClick={() => setColor(c)}
              style={{
                height: 28, borderRadius: 6, background: c,
                border: color === c ? '2px solid var(--text-primary)' : '2px solid transparent',
                cursor: 'pointer',
                boxShadow: color === c ? `0 0 12px ${c}` : 'none',
              }}
            />
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
            }}>
            Annuler
          </button>
          <button
            onClick={() => label.trim() && onCreate(label.trim(), color)}
            disabled={!label.trim()}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40"
            style={{
              background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
              color: '#fff', border: 'none',
              cursor: label.trim() ? 'pointer' : 'not-allowed',
            }}>
            Créer l'état
          </button>
        </div>
      </div>
    </div>
  )
}
