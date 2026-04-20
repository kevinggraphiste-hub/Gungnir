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
  X, Check, Loader2, Edit3, GripVertical,
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
  description: string
  status_key: string
  position: number
  expanded: boolean
  subtasks: SubtaskT[]
  created_at: string | null
  updated_at: string | null
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
    const filtered = filter == null ? cards : cards.filter(c => c.status_key === filter)
    return [...filtered].sort((a, b) => a.position - b.position)
  }, [cards, filter])

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

        {/* ── Filter bar ───────────────────────────────────────── */}
        {activeProject && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-[2px]"
              style={{ color: 'var(--text-muted)', marginRight: 4 }}>
              Filtre
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
            {visibleCards.length === 0 ? (
              <div className="flex items-center justify-center h-96 text-sm" style={{ color: 'var(--text-muted)' }}>
                {cards.length === 0
                  ? 'Aucune carte — utilise le formulaire ci-dessus pour créer la première.'
                  : `Aucune carte "${getStatus(filter || '').label}". Clique "Tout" pour voir les autres.`}
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, 260px)',
                gridAutoRows: 260,
                gap: 14,
                justifyContent: 'start',
              }}>
                {visibleCards.map((card, idx) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    status={getStatus(card.status_key)}
                    statuses={statuses}
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
  card, status, statuses, isDragged, isDropTarget,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onUpdate, onDelete,
}: {
  card: CardT
  status: StatusT
  statuses: StatusT[]
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

  const doneCount = card.subtasks.filter(s => s.done).length
  const totalSubtasks = card.subtasks.length
  const progress = totalSubtasks > 0 ? doneCount / totalSubtasks : 0

  const toggleExpanded = () => onUpdate({ expanded: !card.expanded })

  const setStatus = (key: string) => {
    setStatusMenuOpen(false)
    onUpdate({ status_key: key })
  }

  const toggleSubtask = (sid: string) => {
    const next = card.subtasks.map(s => s.id === sid ? { ...s, done: !s.done } : s)
    onUpdate({ subtasks: next })
  }

  const addSubtask = () => {
    const label = newSubtaskLabel.trim()
    if (!label) return
    const next = [...card.subtasks, { id: newSubtaskId(), label, done: false }]
    onUpdate({ subtasks: next })
    setNewSubtaskLabel('')
  }

  const removeSubtask = (sid: string) => {
    onUpdate({ subtasks: card.subtasks.filter(s => s.id !== sid) })
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
            <EditableText
              value={card.title}
              onSave={v => onUpdate({ title: v })}
              className="text-sm font-semibold"
              style={{ color: 'var(--text-primary)', lineHeight: 1.35 }}
              singleLine
            />
          ) : (
            <div className="text-sm font-semibold" style={{
              color: 'var(--text-primary)', lineHeight: 1.35,
              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {card.title || 'Sans titre'}
            </div>
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

      {/* Body (toujours visible mais différent selon expanded) */}
      <div style={{ flex: 1, padding: 12, paddingTop: card.expanded ? 10 : 0, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {card.expanded ? (
          <>
            <EditableText
              value={card.description}
              onSave={v => onUpdate({ description: v })}
              placeholder="Description (clique pour éditer)…"
              className="text-xs"
              style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
            />

            {/* Subtasks */}
            <div style={{ flex: 1, overflowY: 'auto', marginTop: 4 }}>
              {card.subtasks.length > 0 && (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
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
                  </div>
                </>
              )}
              {card.subtasks.map(st => (
                <div key={st.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 0', fontSize: 12,
                }}>
                  <button onClick={() => toggleSubtask(st.id)}
                    style={{
                      flexShrink: 0, width: 14, height: 14,
                      borderRadius: 4, border: `1.5px solid ${st.done ? 'var(--scarlet)' : 'var(--border)'}`,
                      background: st.done ? 'var(--scarlet)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', padding: 0,
                    }}>
                    {st.done && <Check className="w-2.5 h-2.5" style={{ color: '#fff' }} strokeWidth={3} />}
                  </button>
                  <span style={{
                    flex: 1,
                    textDecoration: st.done ? 'line-through' : 'none',
                    color: st.done ? 'var(--text-muted)' : 'var(--text-primary)',
                  }}>{st.label}</span>
                  <button onClick={() => removeSubtask(st.id)}
                    style={{
                      background: 'none', border: 'none', padding: 2, cursor: 'pointer',
                      color: 'var(--text-muted)', opacity: 0.5,
                    }}
                    onMouseOver={e => (e.currentTarget.style.opacity = '1')}
                    onMouseOut={e => (e.currentTarget.style.opacity = '0.5')}>
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
                  value={newSubtaskLabel}
                  onChange={e => setNewSubtaskLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addSubtask()}
                  onBlur={addSubtask}
                  placeholder="Nouvelle sous-tâche…"
                  style={{
                    flex: 1, background: 'transparent', border: 'none',
                    fontSize: 11.5, color: 'var(--text-primary)', outline: 'none',
                  }}
                />
              </div>
            </div>

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
            {totalSubtasks > 0 && (
              <div style={{
                marginTop: 'auto',
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 10, color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
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
              </div>
            )}
            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
              <GripVertical className="w-3 h-3" style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
              <span style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.6 }}>
                glisser pour déplacer
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
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
