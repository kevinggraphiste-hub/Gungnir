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
  Calendar, Copy, AlertTriangle, Sparkles, Eye, FileText, BarChart3,
  RotateCcw, Bell, Keyboard, CheckSquare, Undo2, Upload, ArrowUpDown,
  CalendarDays, Repeat,
} from 'lucide-react'
import InfoButton from '@core/components/InfoButton'
import manifest from './manifest.json'
import { MarkdownBlock } from './markdown'

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
  due_date: string | null    // ISO YYYY-MM-DD ou null
  archived_at: string | null // ISO datetime ou null
  origin: string             // "", "duplicate", "conscience:goal:<id>", "template:<key>"
  recurrence_rule: string    // "", "daily", "weekly[:1,3,5]", "monthly"
  created_at: string | null
  updated_at: string | null
}

interface TagEntryT { label: string; count: number }

interface TemplateT {
  key: string
  title: string
  description: string
  card_count: number
}

interface ConscienceGoalT {
  id: string
  title: string
  description: string
  status: string
  progress: number
  imported: boolean
  origin_key: string
}

interface StatsT {
  total: number
  by_status: Record<string, number>
  overdue: number
  due_this_week: number
  done_this_week: number
  archived: number
  subtasks_total: number
  subtasks_done: number
}

interface ReminderItemT {
  id: number
  project_id: number
  project_title: string
  title: string
  status_key: string
  due_date: string
  days_diff: number
}

interface RemindersT {
  overdue: ReminderItemT[]
  today: ReminderItemT[]
  soon: ReminderItemT[]
  total: number
}

// Représentation d'une action annulable — stockée en pile.
type UndoEntry =
  | { type: 'delete'; card: CardT }
  | { type: 'archive'; cardId: number }
  | { type: 'bulk_archive'; cardIds: number[] }
  | { type: 'bulk_delete'; cards: CardT[] }
  | { type: 'status_change'; cardId: number; previous: string }

// Palette de couleurs pour les tags : dérivée du hash du label → index stable
const TAG_COLORS = [
  '#dc2626', '#ef4444', '#f97316', '#f59e0b',
  '#eab308', '#84cc16', '#22c55e', '#10b981',
  '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e',
]

function colorForTag(label: string): string {
  // Hash stable — simple djb2 tronqué → index dans la palette.
  // Hash sur lowercase pour que DEV / Dev / dev partagent la même couleur.
  const key = (label || '').toLowerCase()
  let hash = 5381
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash) + key.charCodeAt(i)
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

// Format canonique d'affichage pour un tag — première lettre UPPER, reste LOWER.
// Défensif : le backend normalise déjà à l'écriture ET à la lecture, mais on
// applique aussi côté UI pour rendre un display cohérent même si un tag
// arrive non normalisé (cas edge : import, données anciennes, etc.).
function displayTag(label: string): string {
  if (!label) return ''
  const s = label.trim()
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
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
  // Verrou date — alimenté UNIQUEMENT par un clic sur une journée du
  // calendrier. Format ISO local YYYY-MM-DD ou null. Quand actif, c'est un
  // filtre PRIORITAIRE qui bypass tous les autres : la grille n'affiche
  // strictement que les cartes avec cette due_date, peu importe status/tags/
  // search/archive. Pour le retirer : bouton X dans le bandeau scarlet, ou
  // rebascule en vue calendrier puis re-clique sur une autre date.
  const [dueDateFilter, setDueDateFilter] = useState<string | null>(null)
  const [allTags, setAllTags] = useState<TagEntryT[]>([])
  const [showExportMenu, setShowExportMenu] = useState(false)

  // Archive / stats / templates / conscience
  const [showArchived, setShowArchived] = useState(false)
  const [archivedCards, setArchivedCards] = useState<CardT[]>([])
  const [stats, setStats] = useState<StatsT | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [templates, setTemplates] = useState<TemplateT[]>([])
  const [showNewProjectModal, setShowNewProjectModal] = useState(false)
  const [conscienceGoals, setConscienceGoals] = useState<ConscienceGoalT[]>([])
  const [showConscienceModal, setShowConscienceModal] = useState(false)
  const [conscienceLoading, setConscienceLoading] = useState(false)
  const [mdPreview, setMdPreview] = useState(true) // render markdown in descriptions

  // Rappels (deadlines) — tous projets user confondus.
  const [reminders, setReminders] = useState<RemindersT | null>(null)
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [remindersDismissed, setRemindersDismissed] = useState(() => {
    try {
      const key = `valkyrie_reminders_dismissed_${new Date().toISOString().slice(0, 10)}`
      return localStorage.getItem(key) === '1'
    } catch { return false }
  })

  // Bulk ops (multi-sélection)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedCardIds, setSelectedCardIds] = useState<Set<number>>(new Set())

  // Tri de la grille + vue (grille/calendrier) + toasts globaux
  type SortKey = 'position' | 'due_asc' | 'due_desc' | 'title_asc' | 'progress_desc' | 'recent'
  const [sortBy, setSortBy] = useState<SortKey>('position')
  const [viewMode, setViewMode] = useState<'grid' | 'calendar'>('grid')
  const [toast, setToast] = useState<{ message: string; action?: { label: string; run: () => void }; key: number } | null>(null)
  const showToast = useCallback((message: string, action?: { label: string; run: () => void }) => {
    setToast({ message, action, key: Date.now() })
  }, [])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(id)
  }, [toast])

  // ── Verrou date : source unique de vérité ────────────────────────────
  // Quand `dueDateFilter` est posé (par le clic calendrier ou un setter
  // externe), on force atomiquement la vue grille + reset de tous les autres
  // filtres. Ça garantit que peu importe l'ordre/le timing des setters
  // appelants, l'état converge toujours vers « verrou date pur ».
  useEffect(() => {
    if (dueDateFilter) {
      setViewMode('grid')
      setSearchQuery('')
      setTagFilter([])
      setFilter(null)
      setShowArchived(false)
      // eslint-disable-next-line no-console
      console.log('[valkyrie] verrou date activé →', dueDateFilter)
    }
  }, [dueDateFilter])

  // Import docs modal
  const [showImportModal, setShowImportModal] = useState(false)

  // Undo stack (limité à 30 entrées)
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([])
  const pushUndo = useCallback((entry: UndoEntry) => {
    setUndoStack(prev => {
      const next = [...prev, entry]
      return next.length > 30 ? next.slice(next.length - 30) : next
    })
  }, [])

  // Raccourcis clavier
  const [showShortcuts, setShowShortcuts] = useState(false)

  // Refs pour focus shortcuts (recherche / nouvelle carte)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const newCardInputRef = useRef<HTMLInputElement | null>(null)

  const activeProject = useMemo(
    () => projects.find(p => p.id === activeProjectId) || null,
    [projects, activeProjectId]
  )

  // ── Initial load ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [pRes, sRes, palRes, tRes] = await Promise.all([
          jget<{ projects: ProjectT[] }>(`${API}/projects`),
          jget<{ statuses: StatusT[] }>(`${API}/statuses`),
          jget<{ colors: string[] }>(`${API}/palette`),
          jget<{ templates: TemplateT[] }>(`${API}/templates`).catch(() => ({ templates: [] })),
        ])
        if (cancelled) return
        setProjects(pRes.projects || [])
        setStatuses(sRes.statuses || [])
        setPalette(palRes.colors || [])
        setTemplates(tRes.templates || [])
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

  // ── Stats : rafraîchies quand on change de projet ou qu'on ouvre le panel.
  const refreshStats = useCallback(async () => {
    if (!activeProjectId) return
    try {
      const r = await jget<StatsT>(`${API}/projects/${activeProjectId}/stats`)
      setStats(r)
    } catch { /* silencieux */ }
  }, [activeProjectId])
  useEffect(() => {
    if (!activeProjectId) return
    refreshStats()
  }, [activeProjectId, cards.length, refreshStats])

  // ── Archived cards : chargées quand on active la vue.
  useEffect(() => {
    if (!showArchived || !activeProjectId) { setArchivedCards([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await jget<{ cards: CardT[] }>(
          `${API}/projects/${activeProjectId}/cards?archived_only=true`
        )
        if (!cancelled) setArchivedCards(r.cards || [])
      } catch (err) { console.warn('archived load failed:', err) }
    })()
    return () => { cancelled = true }
  }, [showArchived, activeProjectId])

  // ── Rappels : fetch au démarrage + après chaque mutation sur les cartes.
  const refreshReminders = useCallback(async () => {
    try {
      const r = await jget<RemindersT>(`${API}/reminders`)
      setReminders(r)
      // Si >0 rappels urgents (overdue + today) et pas encore dismissed,
      // on ouvre le panneau automatiquement à la première passe.
      if ((r.overdue.length + r.today.length) > 0 && !remindersDismissed) {
        setRemindersOpen(true)
      }
    } catch { /* silencieux */ }
  }, [remindersDismissed])

  useEffect(() => { refreshReminders() }, [refreshReminders, cards.length])

  const dismissReminders = useCallback(() => {
    setRemindersDismissed(true)
    setRemindersOpen(false)
    try {
      const key = `valkyrie_reminders_dismissed_${new Date().toISOString().slice(0, 10)}`
      localStorage.setItem(key, '1')
    } catch { /* ignore */ }
  }, [])

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
    const before = cards.find(c => c.id === cardId) || null
    if (optimistic) {
      setCards(prev => prev.map(c => c.id === cardId ? { ...c, ...updates } : c))
    }
    try {
      const r = await jsend<{ card: CardT; spawned?: CardT }>(`${API}/cards/${cardId}`, 'PUT', updates)
      setCards(prev => {
        // Si la carte a été auto-archivée par la récurrence, on la retire
        if (r.card.archived_at) {
          const next = prev.filter(c => c.id !== cardId)
          if (r.spawned) next.push(r.spawned)
          return next
        }
        return prev.map(c => c.id === cardId ? r.card : c)
      })
      if (r.spawned) {
        showToast(
          `Récurrence : nouvelle carte "${r.spawned.title}" créée pour le ${r.spawned.due_date || '?'}.`
        )
      }
      // Auto-statut : toutes les sous-tâches cochées ⇒ propose de passer en Fait
      if (before && r.card.status_key !== 'done') {
        const all = [...(r.card.subtasks || []), ...(r.card.subtasks2 || [])]
        const beforeAll = [...(before.subtasks || []), ...(before.subtasks2 || [])]
        const nowComplete = all.length > 0 && all.every(s => s.done)
        const wasComplete = beforeAll.length > 0 && beforeAll.every(s => s.done)
        if (nowComplete && !wasComplete) {
          const cid = r.card.id
          const prev = r.card.status_key
          showToast(
            `Toutes les sous-tâches de "${r.card.title}" sont cochées.`,
            {
              label: 'Passer en Fait',
              run: async () => {
                pushUndo({ type: 'status_change', cardId: cid, previous: prev })
                try {
                  const rr = await jsend<{ card: CardT }>(
                    `${API}/cards/${cid}`, 'PUT', { status_key: 'done' }
                  )
                  setCards(p => p.map(c => c.id === cid ? rr.card : c))
                } catch { /* ignore */ }
              },
            }
          )
        }
      }
    } catch (err) {
      console.warn('updateCard failed:', err)
    }
  }, [cards, pushUndo, showToast])

  const deleteCard = useCallback(async (cardId: number) => {
    if (!confirm('Supprimer cette carte ?')) return
    const snapshot = cards.find(c => c.id === cardId) || archivedCards.find(c => c.id === cardId)
    try {
      await jsend(`${API}/cards/${cardId}`, 'DELETE')
      setCards(prev => prev.filter(c => c.id !== cardId))
      setArchivedCards(prev => prev.filter(c => c.id !== cardId))
      if (snapshot) pushUndo({ type: 'delete', card: snapshot })
    } catch (err) {
      console.warn('deleteCard failed:', err)
    }
  }, [cards, archivedCards, pushUndo])

  const archiveCard = useCallback(async (cardId: number) => {
    try {
      const r = await jsend<{ card: CardT }>(`${API}/cards/${cardId}/archive`, 'POST')
      setCards(prev => prev.filter(c => c.id !== cardId))
      setArchivedCards(prev => [r.card, ...prev.filter(c => c.id !== cardId)])
      pushUndo({ type: 'archive', cardId })
    } catch (err) { console.warn('archiveCard failed:', err) }
  }, [pushUndo])

  const restoreCard = useCallback(async (cardId: number) => {
    try {
      const r = await jsend<{ card: CardT }>(`${API}/cards/${cardId}/restore`, 'POST')
      setArchivedCards(prev => prev.filter(c => c.id !== cardId))
      setCards(prev => [...prev, r.card])
    } catch (err) { console.warn('restoreCard failed:', err) }
  }, [])

  const duplicateCard = useCallback(async (cardId: number) => {
    try {
      const r = await jsend<{ card: CardT }>(`${API}/cards/${cardId}/duplicate`, 'POST')
      // Re-fetch pour récupérer les positions décalées
      if (activeProjectId) {
        const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
        setCards(cs.cards || [])
      } else {
        setCards(prev => [...prev, r.card])
      }
    } catch (err) { console.warn('duplicateCard failed:', err) }
  }, [activeProjectId])

  // ── Templates : création depuis un modèle ─────────────────────────
  const createProjectFromTemplate = useCallback(async (templateKey: string, title?: string) => {
    try {
      const r = await jsend<{ project: ProjectT }>(`${API}/projects`, 'POST', {
        template: templateKey,
        title: title || undefined,
      })
      setProjects(prev => [...prev, r.project])
      setActiveProjectId(r.project.id)
      setShowNewProjectModal(false)
      setShowProjectMenu(false)
    } catch (err) {
      console.warn('createProjectFromTemplate failed:', err)
    }
  }, [])

  // ── Conscience : fetch goals + import sélectif ───────────────────
  const openConscienceModal = useCallback(async () => {
    if (!activeProjectId) return
    setShowConscienceModal(true)
    setConscienceLoading(true)
    try {
      const r = await jget<{ goals: ConscienceGoalT[] }>(
        `${API}/projects/${activeProjectId}/conscience-goals`
      )
      setConscienceGoals(r.goals || [])
    } catch (err) {
      console.warn('load conscience goals failed:', err)
      setConscienceGoals([])
    } finally { setConscienceLoading(false) }
  }, [activeProjectId])

  const syncConscienceGoals = useCallback(async (goalIds: string[]) => {
    if (!activeProjectId) return
    try {
      await jsend(`${API}/projects/${activeProjectId}/sync-goals`, 'POST', { goal_ids: goalIds })
      // Refetch cards
      const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
      setCards(cs.cards || [])
      setShowConscienceModal(false)
    } catch (err) {
      console.warn('sync goals failed:', err)
    }
  }, [activeProjectId])

  // ── Bulk ops (multi-sélection) ──────────────────────────────────
  const toggleCardSelected = useCallback((cardId: number) => {
    setSelectedCardIds(prev => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => {
    setSelectedCardIds(new Set())
    setSelectMode(false)
  }, [])

  const bulkRun = useCallback(async (
    action: 'archive' | 'delete' | 'set_status' | 'add_tag' | 'remove_tag' | 'restore',
    extra?: { status_key?: string; tag?: string },
  ) => {
    const ids = Array.from(selectedCardIds)
    if (ids.length === 0) return
    // Snapshot pour undo (archive/delete)
    const snapshot = cards.filter(c => selectedCardIds.has(c.id))
    try {
      await jsend(`${API}/cards/bulk`, 'POST', { card_ids: ids, action, ...extra })
      if (action === 'archive') {
        setCards(prev => prev.filter(c => !selectedCardIds.has(c.id)))
        pushUndo({ type: 'bulk_archive', cardIds: ids })
      } else if (action === 'delete') {
        setCards(prev => prev.filter(c => !selectedCardIds.has(c.id)))
        setArchivedCards(prev => prev.filter(c => !selectedCardIds.has(c.id)))
        pushUndo({ type: 'bulk_delete', cards: snapshot })
      } else if (action === 'restore') {
        // refetch normal cards and clear archived list
        if (activeProjectId) {
          const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
          setCards(cs.cards || [])
        }
        setArchivedCards(prev => prev.filter(c => !selectedCardIds.has(c.id)))
      } else {
        // set_status / add_tag / remove_tag : simple refetch
        if (activeProjectId) {
          const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
          setCards(cs.cards || [])
        }
      }
      clearSelection()
    } catch (err) {
      console.warn('bulk failed:', err)
    }
  }, [selectedCardIds, cards, activeProjectId, pushUndo, clearSelection])

  // ── Undo : inverse la dernière action sur la pile ─────────────
  const undoLast = useCallback(async () => {
    setUndoStack(prev => {
      const stack = [...prev]
      const last = stack.pop()
      if (!last) return prev
      ;(async () => {
        try {
          if (last.type === 'archive') {
            const r = await jsend<{ card: CardT }>(`${API}/cards/${last.cardId}/restore`, 'POST')
            setArchivedCards(p => p.filter(c => c.id !== last.cardId))
            setCards(p => [...p, r.card])
          } else if (last.type === 'bulk_archive') {
            await Promise.all(last.cardIds.map(id =>
              jsend<{ card: CardT }>(`${API}/cards/${id}/restore`, 'POST')
            ))
            if (activeProjectId) {
              const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
              setCards(cs.cards || [])
            }
          } else if (last.type === 'delete' || last.type === 'bulk_delete') {
            // Recrée les cartes (best-effort — nouveaux IDs). On informe l'user.
            const srcCards = last.type === 'delete' ? [last.card] : last.cards
            for (const c of srcCards) {
              try {
                await jsend(`${API}/projects/${c.project_id}/cards`, 'POST', {
                  title: c.title, subtitle: c.subtitle, description: c.description,
                  status_key: c.status_key, position: c.position,
                  subtasks: c.subtasks, subtasks2: c.subtasks2,
                  subtasks2_title: c.subtasks2_title, tags: c.tags,
                  due_date: c.due_date || undefined,
                })
              } catch { /* best effort */ }
            }
            if (activeProjectId) {
              const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
              setCards(cs.cards || [])
            }
          } else if (last.type === 'status_change') {
            await jsend(`${API}/cards/${last.cardId}`, 'PUT', { status_key: last.previous })
            setCards(p => p.map(c => c.id === last.cardId ? { ...c, status_key: last.previous } : c))
          }
        } catch (err) { console.warn('undo failed:', err) }
      })()
      return stack
    })
  }, [activeProjectId])

  // ── Navigation depuis un rappel : change de projet + scroll / expand ──
  const gotoCard = useCallback(async (projectId: number, cardId: number) => {
    setShowArchived(false)
    setActiveProjectId(projectId)
    setRemindersOpen(false)
    // Expand la carte ciblée après un petit délai (le temps du refetch)
    setTimeout(async () => {
      try {
        await jsend(`${API}/cards/${cardId}`, 'PUT', { expanded: true })
        setCards(prev => prev.map(c => c.id === cardId ? { ...c, expanded: true } : c))
      } catch { /* ignore */ }
    }, 400)
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

  // ── Raccourcis clavier ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore quand on tape dans un input/textarea (sauf Escape/Ctrl+Z)
      const target = e.target as HTMLElement | null
      const inField = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
      const modal = showStatusModal || showNewProjectModal || showConscienceModal || showShortcuts
      // Escape : ferme modals / vide sélection / sort du mode select
      if (e.key === 'Escape') {
        if (modal) return // les modals gèrent leur propre Escape via onClick
        if (selectMode) { clearSelection(); e.preventDefault(); return }
        if (searchQuery) { setSearchQuery(''); e.preventDefault(); return }
        if (filter != null) { setFilter(null); e.preventDefault(); return }
      }
      if (inField) return
      // N : focus la saisie nouvelle carte
      if (e.key === 'n' || e.key === 'N') {
        if (!modal && activeProjectId) {
          newCardInputRef.current?.focus(); e.preventDefault()
        }
      }
      // / : focus recherche
      else if (e.key === '/') {
        if (!modal) { searchInputRef.current?.focus(); e.preventDefault() }
      }
      // S : toggle select mode
      else if ((e.key === 's' || e.key === 'S') && !modal && activeProjectId) {
        setSelectMode(v => { if (v) clearSelection(); return !v })
        e.preventDefault()
      }
      // A : toggle archive view
      else if ((e.key === 'a' || e.key === 'A') && !modal && activeProjectId) {
        setShowArchived(v => !v); e.preventDefault()
      }
      // ? : help
      else if (e.key === '?') {
        setShowShortcuts(v => !v); e.preventDefault()
      }
      // Ctrl/Cmd+Z : undo
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (undoStack.length > 0) { undoLast(); e.preventDefault() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    showStatusModal, showNewProjectModal, showConscienceModal, showShortcuts,
    selectMode, searchQuery, filter, activeProjectId, undoStack.length,
    clearSelection, undoLast,
  ])

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
    // VERROU DATE PRIORITAIRE : si actif, on bypass tous les autres filtres
    // et on retourne UNIQUEMENT les cartes du jour cliqué — comportement
    // demandé pour le clic calendrier (isolation totale).
    if (dueDateFilter) {
      const target = dueDateFilter.slice(0, 10)
      return cards
        .filter(c => (c.due_date || '').slice(0, 10) === target)
        .sort((a, b) => a.position - b.position)
    }
    // En mode archive, on affiche les archivedCards sans filtre
    const source = showArchived ? archivedCards : cards
    const q = searchQuery.trim().toLowerCase()
    const tags = tagFilter.map(t => t.toLowerCase())
    const filtered = source.filter(c => {
      if (!showArchived && filter != null && c.status_key !== filter) return false
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
    const progressOf = (c: CardT) => {
      const all = [...(c.subtasks || []), ...(c.subtasks2 || [])]
      if (all.length === 0) return 0
      return all.filter(s => s.done).length / all.length
    }
    const cmp = (a: CardT, b: CardT): number => {
      switch (sortBy) {
        case 'due_asc': {
          // Sans date = en dernier
          if (!a.due_date && !b.due_date) return a.position - b.position
          if (!a.due_date) return 1
          if (!b.due_date) return -1
          return a.due_date.localeCompare(b.due_date)
        }
        case 'due_desc': {
          if (!a.due_date && !b.due_date) return a.position - b.position
          if (!a.due_date) return 1
          if (!b.due_date) return -1
          return b.due_date.localeCompare(a.due_date)
        }
        case 'title_asc':
          return (a.title || '').localeCompare(b.title || '', 'fr', { sensitivity: 'base' })
        case 'progress_desc':
          return progressOf(b) - progressOf(a)
        case 'recent':
          return (b.updated_at || '').localeCompare(a.updated_at || '')
        case 'position':
        default:
          return a.position - b.position
      }
    }
    return [...filtered].sort(cmp)
  }, [cards, archivedCards, showArchived, filter, searchQuery, tagFilter, sortBy, dueDateFilter])

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
                      border: 'none', cursor: 'pointer', fontSize: 'var(--font-md)',
                    }}>
                    {p.title}
                  </button>
                ))}
                <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
                <button
                  onClick={() => { setShowProjectMenu(false); setShowNewProjectModal(true) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    width: '100%', textAlign: 'left',
                    padding: '6px 10px', borderRadius: 6,
                    background: 'transparent', color: 'var(--scarlet)',
                    border: 'none', cursor: 'pointer', fontSize: 'var(--font-md)', fontWeight: 600,
                  }}>
                  <Plus className="w-3.5 h-3.5" /> Nouveau tableau…
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
            {/* Titre + description en pleine largeur (pas de toolbar à côté) */}
            <div style={{ minWidth: 0 }}>
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

            {/* Toolbar d'actions en ligne dédiée — évite le chevauchement
                avec le titre quand la description est longue. */}
            <div className="mt-3 pt-3"
              style={{
                borderTop: '1px dashed var(--border)',
                display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              }}>
              {/* Groupe 1 : vue / navigation */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {/* Bell : rappels deadlines (tout projet confondu) */}
                <button onClick={() => { setRemindersOpen(v => !v); refreshReminders() }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    position: 'relative',
                    background: (reminders?.overdue.length || 0) > 0
                      ? 'rgba(239,68,68,0.12)' : 'var(--bg-tertiary)',
                    border: `1px solid ${(reminders?.overdue.length || 0) > 0
                      ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
                    color: (reminders?.overdue.length || 0) > 0
                      ? '#ef4444' : 'var(--text-secondary)',
                  }}
                  title="Rappels (deadlines)">
                  <Bell className="w-3.5 h-3.5" /> Rappels
                  {reminders && reminders.total > 0 && (
                    <span style={{
                      fontSize: 'var(--font-2xs)', fontWeight: 700,
                      padding: '1px 5px', borderRadius: 4,
                      background: reminders.overdue.length > 0 ? '#ef4444' : 'var(--scarlet)',
                      color: '#fff',
                    }}>{reminders.total}</span>
                  )}
                </button>
                <button onClick={() => setViewMode(v => v === 'grid' ? 'calendar' : 'grid')}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: viewMode === 'calendar' ? 'color-mix(in srgb, var(--scarlet) 14%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    color: viewMode === 'calendar' ? 'var(--scarlet)' : 'var(--text-secondary)',
                  }}
                  title={viewMode === 'grid' ? 'Passer en vue calendrier' : 'Repasser en vue grille'}>
                  {viewMode === 'grid'
                    ? (<><CalendarDays className="w-3.5 h-3.5" /> Calendrier</>)
                    : (<><LayoutGrid className="w-3.5 h-3.5" /> Grille</>)}
                </button>
                <SortMenu sortBy={sortBy} onChange={setSortBy} />
                <button onClick={() => setShowImportModal(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                  title="Importer des cartes (JSON / CSV / Markdown)">
                  <Upload className="w-3.5 h-3.5" /> Importer
                </button>
                <button onClick={() => { setSelectMode(v => !v); if (selectMode) clearSelection() }}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: selectMode ? 'color-mix(in srgb, var(--scarlet) 14%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    color: selectMode ? 'var(--scarlet)' : 'var(--text-secondary)',
                  }}
                  title="Sélection multiple (S)">
                  <CheckSquare className="w-3.5 h-3.5" /> Sélection
                </button>
                <button onClick={undoLast}
                  disabled={undoStack.length === 0}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    color: undoStack.length > 0 ? 'var(--text-secondary)' : 'var(--text-muted)',
                    cursor: undoStack.length > 0 ? 'pointer' : 'not-allowed',
                  }}
                  title={`Annuler (Ctrl+Z) — ${undoStack.length} action(s) annulables`}>
                  <Undo2 className="w-3.5 h-3.5" /> Undo
                </button>
                <button onClick={() => setShowShortcuts(true)}
                  className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                  title="Raccourcis clavier (?)">
                  <Keyboard className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
                <button onClick={() => setShowStats(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: showStats ? 'color-mix(in srgb, var(--scarlet) 14%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    color: showStats ? 'var(--scarlet)' : 'var(--text-secondary)',
                  }}
                  title="Afficher/masquer le mini-dashboard">
                  <BarChart3 className="w-3.5 h-3.5" /> Stats
                </button>
              </div>

              {/* Spacer : pousse le groupe projet à droite sur grand écran */}
              <div style={{ flex: 1, minWidth: 8 }} />

              {/* Groupe 2 : archives / conscience / paramètres projet */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <button onClick={() => setShowArchived(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: showArchived ? 'color-mix(in srgb, var(--scarlet) 14%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    color: showArchived ? 'var(--scarlet)' : 'var(--text-secondary)',
                  }}
                  title="Voir les cartes archivées">
                  <Archive className="w-3.5 h-3.5" /> Archives {stats?.archived ? `(${stats.archived})` : ''}
                </button>
                <button onClick={openConscienceModal}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                  title="Importer des objectifs depuis la Conscience">
                  <Sparkles className="w-3.5 h-3.5" /> Conscience
                </button>
                <button onClick={() => setMdPreview(v => !v)}
                  className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                  title={mdPreview ? 'Afficher le markdown brut' : 'Afficher le rendu markdown'}>
                  {mdPreview ? (
                    <Eye className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
                  ) : (
                    <FileText className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  )}
                </button>
                <button onClick={deleteProject}
                  className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)]"
                  title="Supprimer le projet">
                  <Trash2 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
                <button onClick={archiveProject}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                  <Archive className="w-3.5 h-3.5" /> Archiver projet
                </button>
              </div>
            </div>

            {/* Mini-dashboard de stats (affichable via bouton) */}
            {showStats && stats && (
              <div className="mt-4 pt-4" style={{ borderTop: '1px dashed var(--border)' }}>
                <StatsPanel stats={stats} statuses={statuses} />
              </div>
            )}

            {/* Ligne nouvelle carte intégrée */}
            <div className="mt-4 pt-4" style={{ borderTop: '1px dashed var(--border)' }}>
              <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 180px auto' }}>
                <input
                  ref={newCardInputRef}
                  value={newCardTitle}
                  onChange={e => setNewCardTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createCard()}
                  placeholder="Nouvelle carte — titre de la tâche… (N)"
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
                ref={searchInputRef}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Rechercher (/ pour focus, titre, description, sous-tâches, tags…)"
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

        {/* ── Verrou date prioritaire (clic calendrier) ── */}
        {activeProject && viewMode === 'grid' && dueDateFilter && (
          <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{
            background: 'color-mix(in srgb, var(--scarlet) 12%, var(--bg-secondary))',
            border: '1px solid color-mix(in srgb, var(--scarlet) 40%, transparent)',
          }}>
            <div className="flex items-center gap-2 text-xs">
              <CalendarDays className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>
                Verrou date —{' '}
                <strong style={{ color: 'var(--scarlet)' }}>
                  {new Date(dueDateFilter + 'T12:00:00').toLocaleDateString('fr-FR', {
                    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                  })}
                </strong>
                {' '}· <strong>{visibleCards.length}</strong> carte{visibleCards.length > 1 ? 's' : ''} (les autres filtres sont ignorés)
              </span>
            </div>
            <button onClick={() => setDueDateFilter(null)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors"
              style={{ color: 'var(--scarlet)', background: 'transparent', border: '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)', cursor: 'pointer' }}>
              <X className="w-3 h-3" /> Retirer le verrou
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
                  {displayTag(t.label)}
                  <span style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 'var(--font-2xs)',
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

        {/* ── Panneau rappels ───────────────────────────────────── */}
        {activeProject && remindersOpen && reminders && reminders.total > 0 && (
          <RemindersPanel
            reminders={reminders}
            onGotoCard={gotoCard}
            onClose={() => setRemindersOpen(false)}
            onDismiss={dismissReminders}
          />
        )}

        {/* ── Barre d'actions bulk (apparaît quand multi-sélection active) ── */}
        {activeProject && selectMode && selectedCardIds.size > 0 && (
          <BulkActionsBar
            count={selectedCardIds.size}
            archivedMode={showArchived}
            statuses={statuses}
            onArchive={() => bulkRun('archive')}
            onRestore={() => bulkRun('restore')}
            onDelete={() => {
              if (confirm(`Supprimer définitivement ${selectedCardIds.size} carte(s) ?`)) bulkRun('delete')
            }}
            onSetStatus={key => bulkRun('set_status', { status_key: key })}
            onAddTag={tag => bulkRun('add_tag', { tag })}
            onClear={clearSelection}
          />
        )}

        {/* ── Calendar view (alternative à la grille) ─────────── */}
        {activeProject && viewMode === 'calendar' && (
          <CalendarView
            cards={showArchived ? archivedCards : cards}
            statuses={statuses}
            onOpenCard={(cid) => {
              setCards(prev => prev.map(c => c.id === cid ? { ...c, expanded: true } : c))
              jsend(`${API}/cards/${cid}`, 'PUT', { expanded: true }).catch(() => {})
              setViewMode('grid')
            }}
            onDayClick={(iso) => {
              // Suffit de poser le filtre — le useEffect [dueDateFilter] reset
              // les autres filtres et bascule en grille atomiquement.
              // eslint-disable-next-line no-console
              console.log('[valkyrie] onDayClick →', iso)
              showToast(`Filtre date posé : ${iso}`)
              setDueDateFilter(iso)
            }}
            onQuickCreate={async (isoDate) => {
              if (!activeProjectId) return
              try {
                const r = await jsend<{ card: CardT }>(
                  `${API}/projects/${activeProjectId}/cards`, 'POST',
                  { title: 'Nouvelle carte', status_key: newCardStatus,
                    position: cards.length, due_date: isoDate, expanded: false }
                )
                setCards(prev => [...prev, r.card])
              } catch (err) { console.warn('calendar create failed:', err) }
            }}
          />
        )}


        {/* ── Grid board ───────────────────────────────────────── */}
        {activeProject && viewMode === 'grid' && (
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
            {visibleCards.length === 0 && (searchQuery || tagFilter.length > 0 || filter != null || dueDateFilter) ? (
              <div className="flex items-center justify-center h-96 text-sm" style={{ color: 'var(--text-muted)' }}>
                Aucune carte ne correspond aux filtres.
              </div>
            ) : (
              <div className="valkyrie-grid" style={{
                display: 'grid',
                // Grid strict via media queries (cf. valkyrie-grid dans
                // index.css) : 1 col mobile, 2 cols ≥ 700px, 3 cols ≥ 1024,
                // 4 cols ≥ 1400. Avec `minmax(0, 1fr)` on FORCE l'égalité
                // des colonnes — sans ça, une card dont le contenu min-
                // content dépasse la base (ex. titre long, badge non-wrap)
                // se voyait attribuer une col plus large que sa voisine,
                // d'où le déséquilibre "carré + rectangle compressé".
                gridAutoRows: 'minmax(260px, auto)',
                gridAutoFlow: 'row dense',
                gap: 14,
              }}>
                {visibleCards.map((card, idx) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    status={getStatus(card.status_key)}
                    statuses={statuses}
                    allTags={allTags}
                    mdPreview={mdPreview}
                    archivedMode={showArchived}
                    selectMode={selectMode}
                    selected={selectedCardIds.has(card.id)}
                    onToggleSelected={() => toggleCardSelected(card.id)}
                    isDragged={draggedId === card.id}
                    isDropTarget={dropTargetIdx === idx}
                    onDragStart={e => handleDragStart(e, card.id)}
                    onDragOver={e => handleDragOver(e, idx)}
                    onDrop={e => handleDrop(e, idx)}
                    onDragEnd={handleDragEnd}
                    onUpdate={updates => updateCard(card.id, updates)}
                    onDelete={() => deleteCard(card.id)}
                    onArchive={() => archiveCard(card.id)}
                    onRestore={() => restoreCard(card.id)}
                    onDuplicate={() => duplicateCard(card.id)}
                  />
                ))}
                {/* Emplacements vides avec "+" — ajouter une carte à la volée.
                    On ajoute plusieurs slots pour combler visuellement la grille
                    même quand elle est quasi-pleine. N'apparaît pas quand un
                    filtre est actif (la grille est "filtrée", pas vide). */}
                {!showArchived && filter == null && !searchQuery && tagFilter.length === 0 && !dueDateFilter && (
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

      {/* ── New project modal (avec templates) ─────────────────── */}
      {showNewProjectModal && (
        <NewProjectModal
          templates={templates}
          onCancel={() => setShowNewProjectModal(false)}
          onCreate={createProjectFromTemplate}
        />
      )}

      {/* ── Conscience goals modal ─────────────────────────────── */}
      {showConscienceModal && (
        <ConscienceGoalsModal
          goals={conscienceGoals}
          loading={conscienceLoading}
          onCancel={() => setShowConscienceModal(false)}
          onImport={syncConscienceGoals}
        />
      )}

      {/* ── Shortcuts help modal ───────────────────────────────── */}
      {showShortcuts && (
        <ShortcutsModal onClose={() => setShowShortcuts(false)} />
      )}

      {/* ── Import modal ───────────────────────────────────────── */}
      {showImportModal && activeProjectId && (
        <ImportModal
          onCancel={() => setShowImportModal(false)}
          onImport={async (format, data) => {
            try {
              const r = await jsend<{ created: number }>(
                `${API}/projects/${activeProjectId}/import`, 'POST', { format, data }
              )
              // Refetch cards
              const cs = await jget<{ cards: CardT[] }>(`${API}/projects/${activeProjectId}/cards`)
              setCards(cs.cards || [])
              showToast(`${r.created} carte${r.created > 1 ? 's' : ''} importée${r.created > 1 ? 's' : ''}.`)
              setShowImportModal(false)
            } catch (err) {
              showToast(`Import échoué : ${String(err).slice(0, 120)}`)
            }
          }}
        />
      )}

      {/* ── Toast (feedback global non bloquant) ──────────────── */}
      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
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
        fontFamily: 'JetBrains Mono, monospace', fontSize: 'var(--font-xs)',
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
  card, status, statuses, allTags, mdPreview, archivedMode,
  selectMode, selected, onToggleSelected,
  isDragged, isDropTarget,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onUpdate, onDelete, onArchive, onRestore, onDuplicate,
}: {
  card: CardT
  status: StatusT
  statuses: StatusT[]
  allTags: TagEntryT[]
  mdPreview: boolean
  archivedMode: boolean
  selectMode: boolean
  selected: boolean
  onToggleSelected: () => void
  isDragged: boolean
  isDropTarget: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onUpdate: (updates: Partial<CardT>) => void
  onDelete: () => void
  onArchive: () => void
  onRestore: () => void
  onDuplicate: () => void
}) {
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [newSubtaskLabel, setNewSubtaskLabel] = useState('')
  const [newSubtask2Label, setNewSubtask2Label] = useState('')

  // Agrégé des 2 listes pour la barre globale en bas
  const allSubs = [...(card.subtasks || []), ...(card.subtasks2 || [])]
  const doneCount = allSubs.filter(s => s.done).length
  const totalSubtasks = allSubs.length
  const progress = totalSubtasks > 0 ? doneCount / totalSubtasks : 0

  // Date limite : overdue si passée et la carte n'est pas "done".
  const dueInfo = useMemo(() => {
    if (!card.due_date) return { overdue: false, soon: false, label: '' }
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const due = new Date(card.due_date + 'T00:00:00')
    const diffDays = Math.floor((due.getTime() - today.getTime()) / 86400000)
    const overdue = diffDays < 0 && card.status_key !== 'done'
    const soon = diffDays >= 0 && diffDays <= 3 && card.status_key !== 'done'
    const label = overdue
      ? `En retard — ${Math.abs(diffDays)} j`
      : diffDays === 0 ? "Aujourd'hui"
      : diffDays === 1 ? 'Demain'
      : diffDays > 0 ? `Dans ${diffDays} j`
      : due.toLocaleDateString('fr-FR')
    return { overdue, soon, label }
  }, [card.due_date, card.status_key])

  const isConscienceCard = (card.origin || '').startsWith('conscience:goal:')

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
      draggable={!card.expanded && !selectMode}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={selectMode ? (e) => { e.stopPropagation(); onToggleSelected() } : undefined}
      // Attribut data-card-expanded lu par index.css pour appliquer
      // grid-column: span 2 UNIQUEMENT en desktop (≥ 1024px). Empêche
      // la régression mobile (où la grille n'a que 2 cols et span 2
      // casse le kanban).
      data-card-expanded={card.expanded ? 'true' : undefined}
      style={{
        // gridRow: span 2 quand expanded → la card prend 2 lignes pour
        // afficher son contenu déplié (mémo, sous-tâches…).
        // gridColumn: span 2 est appliqué via CSS media query dans
        // index.css (.valkyrie-grid > [data-card-expanded="true"]) —
        // uniquement en ≥ 1024px pour éviter les colonnes implicites
        // sur mobile/tablet (rapport user 2026-05-03).
        gridRow: card.expanded ? 'span 2' : undefined,
        background: 'var(--bg-tertiary)',
        border: `1px solid ${
          selected
            ? 'var(--scarlet)'
            : dueInfo.overdue
              ? '#ef4444'
              : card.expanded
                ? 'color-mix(in srgb, var(--scarlet) 35%, var(--border))'
                : isDropTarget ? 'var(--scarlet)' : 'var(--border)'}`,
        borderRadius: 12,
        // Cartes non-expanded : overflow hidden pour garder le kanban compact
        // (titre + meta clippés à 260px). Cartes expanded : overflow visible
        // → laisse le contenu long (mémo, sous-tâches) pousser la hauteur de
        // la carte, en combinaison avec `gridAutoRows: minmax(260px, auto)`.
        overflow: card.expanded ? 'visible' : 'hidden',
        position: 'relative',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s, opacity 0.15s',
        cursor: selectMode ? 'pointer' : (card.expanded ? 'default' : 'grab'),
        opacity: isDragged ? 0.3 : (archivedMode ? 0.75 : 1),
        boxShadow: selected
          ? '0 0 0 2px var(--scarlet), 0 8px 24px rgba(220,38,38,0.2)'
          : card.expanded
            ? '0 12px 40px rgba(0,0,0,0.4), 0 0 0 1px color-mix(in srgb, var(--scarlet) 10%, transparent)'
            : isDropTarget ? '0 0 0 2px var(--scarlet)'
            : dueInfo.overdue ? '0 0 0 1px rgba(239,68,68,0.25)' : 'none',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Overlay checkbox en mode sélection multiple */}
      {selectMode && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 3,
          width: 20, height: 20, borderRadius: 4,
          border: `2px solid ${selected ? 'var(--scarlet)' : 'var(--border)'}`,
          background: selected ? 'var(--scarlet)' : 'var(--bg-secondary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        }}>
          {selected && <Check className="w-3 h-3" style={{ color: '#fff' }} strokeWidth={3} />}
        </div>
      )}
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
        {/* Actions rapides : dupliquer / archiver(ou restaurer) / supprimer.
            Cachées en mode sélection multiple pour éviter la confusion avec
            la checkbox. Click + mousedown stopPropagation → pas de drag
            parasite déclenché depuis l'icône. */}
        {!selectMode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDuplicate() }}
              title="Dupliquer"
              className="hover:opacity-100 transition-opacity"
              style={{
                background: 'transparent', border: 'none', padding: 4, borderRadius: 4,
                color: 'var(--text-muted)', cursor: 'pointer', opacity: 0.5,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <Copy className="w-3 h-3" />
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); archivedMode ? onRestore() : onArchive() }}
              title={archivedMode ? 'Restaurer' : 'Archiver'}
              className="hover:opacity-100 transition-opacity"
              style={{
                background: 'transparent', border: 'none', padding: 4, borderRadius: 4,
                color: 'var(--text-muted)', cursor: 'pointer', opacity: 0.5,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
              {archivedMode ? <RotateCcw className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
            </button>
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              title="Supprimer"
              className="hover:opacity-100 transition-opacity"
              style={{
                background: 'transparent', border: 'none', padding: 4, borderRadius: 4,
                color: '#dc2626', cursor: 'pointer', opacity: 0.5,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
        {/* Status badge (top-right) */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setStatusMenuOpen(v => !v)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '3px 8px', borderRadius: 4,
              background: `color-mix(in srgb, ${status.color} 15%, transparent)`,
              border: `1px solid color-mix(in srgb, ${status.color} 35%, transparent)`,
              color: status.color, fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer',
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
                    color: 'var(--text-primary)', border: 'none', cursor: 'pointer', fontSize: 'var(--font-xs)',
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

            {/* Date limite + origine */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 'var(--font-xs)', color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                textTransform: 'uppercase', letterSpacing: 1.5,
              }}>
                <Calendar className="w-3 h-3" />
                <input
                  type="date"
                  value={card.due_date || ''}
                  onChange={e => onUpdate({ due_date: e.target.value || '' })}
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 4, padding: '2px 4px',
                    fontSize: 10.5, color: 'var(--text-primary)',
                    fontFamily: 'inherit', outline: 'none',
                  }}
                />
                {card.due_date && (
                  <button
                    onClick={() => onUpdate({ due_date: '' })}
                    style={{
                      background: 'transparent', border: 'none', padding: 2,
                      cursor: 'pointer', color: 'var(--text-muted)', opacity: 0.6,
                    }}
                    title="Retirer la date"><X className="w-3 h-3" /></button>
                )}
              </label>
              {card.due_date && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 6px', borderRadius: 4, fontSize: 'var(--font-xs)', fontWeight: 600,
                  background: dueInfo.overdue ? 'rgba(239,68,68,0.15)' :
                    dueInfo.soon ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.12)',
                  color: dueInfo.overdue ? '#ef4444' :
                    dueInfo.soon ? '#f59e0b' : '#10b981',
                }}>
                  {dueInfo.overdue && <AlertTriangle className="w-3 h-3" />}
                  {dueInfo.label}
                </span>
              )}
              {isConscienceCard && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 6px', borderRadius: 4, fontSize: 'var(--font-xs)', fontWeight: 600,
                  background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)',
                  color: 'var(--scarlet)',
                }}>
                  <Sparkles className="w-3 h-3" /> Conscience
                </span>
              )}
              {/* Récurrence : menu déroulant minimal */}
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 'var(--font-xs)', color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                textTransform: 'uppercase', letterSpacing: 1.5,
              }}>
                <Repeat className="w-3 h-3" />
                <select
                  value={card.recurrence_rule || ''}
                  onChange={e => onUpdate({ recurrence_rule: e.target.value })}
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 4, padding: '2px 4px',
                    fontSize: 10.5, color: 'var(--text-primary)',
                    fontFamily: 'inherit', outline: 'none',
                  }}
                  title="Récurrence — quand la carte passe en Fait, la suivante est auto-créée">
                  <option value="">— (aucune)</option>
                  <option value="daily">Tous les jours</option>
                  <option value="weekly">Toutes les semaines</option>
                  <option value="weekly:1">Chaque lundi</option>
                  <option value="weekly:1,3,5">Lun/Mer/Ven</option>
                  <option value="weekly:2,4">Mar/Jeu</option>
                  <option value="monthly">Tous les mois</option>
                </select>
              </label>
            </div>

            {/* Description éditable avec rendu markdown optionnel */}
            <EditableText
              value={card.description}
              onSave={v => onUpdate({ description: v })}
              placeholder="Description (clique pour éditer, supporte le markdown)…"
              className="text-xs"
              style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}
              renderValue={mdPreview ? (v => <MarkdownBlock text={v} />) : undefined}
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
                fontSize: 'var(--font-xs)', color: 'var(--text-muted)',
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

            {/* Footer actions : duplicate + archive/restore + delete */}
            <div style={{
              display: 'flex', justifyContent: 'flex-end', gap: 4,
              paddingTop: 6, borderTop: '1px solid var(--border)', flexWrap: 'wrap',
            }}>
              {archivedMode ? (
                <button onClick={onRestore}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '3px 8px', borderRadius: 6,
                    background: 'transparent',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 40%, transparent)',
                    color: 'var(--scarlet)', fontSize: 'var(--font-xs)', cursor: 'pointer', fontWeight: 600,
                  }}>
                  <RotateCcw className="w-3 h-3" /> Restaurer
                </button>
              ) : (
                <>
                  <button onClick={onDuplicate}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', borderRadius: 6,
                      background: 'transparent', border: '1px solid var(--border)',
                      color: 'var(--text-muted)', fontSize: 'var(--font-xs)', cursor: 'pointer',
                    }}
                    onMouseOver={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--text-muted)' }}
                    onMouseOut={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)' }}>
                    <Copy className="w-3 h-3" /> Dupliquer
                  </button>
                  <button onClick={onArchive}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', borderRadius: 6,
                      background: 'transparent', border: '1px solid var(--border)',
                      color: 'var(--text-muted)', fontSize: 'var(--font-xs)', cursor: 'pointer',
                    }}
                    onMouseOver={e => { e.currentTarget.style.color = '#f59e0b'; e.currentTarget.style.borderColor = '#f59e0b' }}
                    onMouseOut={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)' }}>
                    <Archive className="w-3 h-3" /> Archiver
                  </button>
                </>
              )}
              <button onClick={onDelete}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 6,
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-muted)', fontSize: 'var(--font-xs)', cursor: 'pointer',
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
            {/* Date limite badge + Conscience badge en mode replié */}
            {(card.due_date || isConscienceCard) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {card.due_date && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '1px 6px', borderRadius: 4, fontSize: 9.5, fontWeight: 600,
                    background: dueInfo.overdue ? 'rgba(239,68,68,0.15)' :
                      dueInfo.soon ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.12)',
                    color: dueInfo.overdue ? '#ef4444' :
                      dueInfo.soon ? '#f59e0b' : '#10b981',
                  }}>
                    {dueInfo.overdue ? <AlertTriangle className="w-2.5 h-2.5" /> : <Calendar className="w-2.5 h-2.5" />}
                    {dueInfo.label}
                  </span>
                )}
                {isConscienceCard && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '1px 6px', borderRadius: 4, fontSize: 9.5, fontWeight: 600,
                    background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)',
                    color: 'var(--scarlet)',
                  }}>
                    <Sparkles className="w-2.5 h-2.5" /> Conscience
                  </span>
                )}
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
                      {displayTag(t)}
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
              <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>
                glisser pour déplacer
              </span>
            </div>
            {/* Progress bar tout en bas de la carte repliée */}
            {totalSubtasks > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--font-xs)', color: 'var(--text-muted)',
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
          padding: '4px 0', fontSize: 'var(--font-sm)',
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
            color: c, fontSize: 'var(--font-xs)', fontWeight: 600,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />
            {displayTag(t)}
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
            borderRadius: 4, padding: '1px 6px', fontSize: 'var(--font-xs)',
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
                    color: 'var(--text-primary)', fontSize: 'var(--font-xs)', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                  onMouseOver={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: c }} />
                  <span style={{ flex: 1 }}>{displayTag(s.label)}</span>
                  <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>×{s.count}</span>
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
        fontSize: 'var(--font-xs)', color: hover ? 'var(--scarlet)' : 'var(--text-muted)',
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
              <div style={{ fontSize: 'var(--font-sm)', fontWeight: 600 }}>{lbl}</div>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{desc}</div>
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
  value, onSave, placeholder, className, style, singleLine, renderValue,
}: {
  value: string
  onSave: (v: string) => void
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  singleLine?: boolean
  // Si fourni, utilisé pour afficher la valeur quand on n'est pas en
  // édition (ex: rendu markdown). L'édition reste une textarea brute.
  renderValue?: (v: string) => React.ReactNode
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
      {value
        ? (renderValue ? renderValue(value) : value)
        : (placeholder || ' ')}
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


// ════════════════════════════════════════════════════════════════════════
// StatsPanel — mini-dashboard du projet actif
// ════════════════════════════════════════════════════════════════════════

function StatsPanel({ stats, statuses }: { stats: StatsT; statuses: StatusT[] }) {
  const statusPct = (key: string) => stats.total > 0
    ? Math.round(((stats.by_status[key] || 0) / stats.total) * 100)
    : 0
  const subPct = stats.subtasks_total > 0
    ? Math.round((stats.subtasks_done / stats.subtasks_total) * 100)
    : 0
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[2px] mb-2"
        style={{ color: 'var(--text-muted)' }}>
        Dashboard
      </div>
      {/* 4 KPI cards */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 8, marginBottom: 10,
      }}>
        <Kpi icon={<LayoutGrid className="w-3 h-3" />} label="Total" value={stats.total} />
        <Kpi icon={<AlertTriangle className="w-3 h-3" />} label="En retard"
          value={stats.overdue} tone={stats.overdue > 0 ? 'danger' : undefined} />
        <Kpi icon={<Calendar className="w-3 h-3" />} label="À faire cette semaine"
          value={stats.due_this_week} tone={stats.due_this_week > 0 ? 'warn' : undefined} />
        <Kpi icon={<Check className="w-3 h-3" />} label="Terminé cette semaine"
          value={stats.done_this_week} tone={stats.done_this_week > 0 ? 'ok' : undefined} />
      </div>
      {/* Répartition par statut */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {statuses.map(s => {
          const count = stats.by_status[s.key] || 0
          if (count === 0) return null
          return (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0,
              }} />
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', minWidth: 100 }}>
                {s.label}
              </span>
              <div style={{
                flex: 1, height: 4, borderRadius: 2, background: 'var(--bg-primary)', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', width: `${statusPct(s.key)}%`,
                  background: s.color, transition: 'width 0.3s',
                }} />
              </div>
              <span style={{
                fontSize: 'var(--font-xs)', fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--text-muted)', minWidth: 60, textAlign: 'right',
              }}>{count} · {statusPct(s.key)}%</span>
            </div>
          )
        })}
        {stats.subtasks_total > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <Check className="w-2.5 h-2.5" style={{ color: 'var(--text-muted)' }} />
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', minWidth: 100 }}>
              Sous-tâches
            </span>
            <div style={{
              flex: 1, height: 4, borderRadius: 2, background: 'var(--bg-primary)', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${subPct}%`,
                background: 'var(--scarlet)', transition: 'width 0.3s',
              }} />
            </div>
            <span style={{
              fontSize: 'var(--font-xs)', fontFamily: 'JetBrains Mono, monospace',
              color: 'var(--text-muted)', minWidth: 60, textAlign: 'right',
            }}>{stats.subtasks_done}/{stats.subtasks_total}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Kpi({
  icon, label, value, tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone?: 'ok' | 'warn' | 'danger'
}) {
  const color = tone === 'danger' ? '#ef4444'
    : tone === 'warn' ? '#f59e0b'
    : tone === 'ok' ? '#10b981'
    : 'var(--text-primary)'
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 8,
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ color }}>{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 'var(--font-2xs)', color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          textTransform: 'uppercase', letterSpacing: 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{label}</div>
        <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700, color, lineHeight: 1.2 }}>{value}</div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// NewProjectModal — création avec choix de template
// ════════════════════════════════════════════════════════════════════════

function NewProjectModal({
  templates, onCancel, onCreate,
}: {
  templates: TemplateT[]
  onCancel: () => void
  onCreate: (templateKey: string, title?: string) => void
}) {
  const [selectedKey, setSelectedKey] = useState('blank')
  const [customTitle, setCustomTitle] = useState('')
  const active = templates.find(t => t.key === selectedKey)
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, minWidth: 480, maxWidth: 620, width: '90%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Nouveau tableau
          </h2>
          <button onClick={onCancel} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', padding: 4,
          }}><X className="w-4 h-4" /></button>
        </div>
        <div className="text-[10px] font-mono uppercase tracking-[2px] mb-2"
          style={{ color: 'var(--text-muted)' }}>
          Modèle de départ
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {templates.length === 0 && (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)' }}>
              Aucun modèle disponible.
            </div>
          )}
          {templates.map(t => (
            <button key={t.key}
              onClick={() => setSelectedKey(t.key)}
              style={{
                textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                background: selectedKey === t.key
                  ? 'color-mix(in srgb, var(--scarlet) 10%, var(--bg-tertiary))'
                  : 'var(--bg-tertiary)',
                border: `1px solid ${selectedKey === t.key
                  ? 'color-mix(in srgb, var(--scarlet) 40%, transparent)'
                  : 'var(--border)'}`,
                color: 'var(--text-primary)', cursor: 'pointer',
              }}>
              <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, marginBottom: 2 }}>
                {t.title}
                <span style={{
                  marginLeft: 8, padding: '1px 6px', borderRadius: 4,
                  fontSize: 9.5, fontWeight: 600,
                  background: 'var(--bg-primary)', color: 'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace',
                }}>
                  {t.card_count} cartes
                </span>
              </div>
              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {t.description || '—'}
              </div>
            </button>
          ))}
        </div>
        <div className="text-[10px] font-mono uppercase tracking-[2px] mb-1"
          style={{ color: 'var(--text-muted)' }}>
          Titre (optionnel)
        </div>
        <input
          value={customTitle}
          onChange={e => setCustomTitle(e.target.value)}
          placeholder={active?.title || 'Nouveau projet'}
          className="w-full mb-4 outline-none"
          style={{
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            color: 'var(--text-primary)', borderRadius: 8, padding: '8px 10px', fontSize: 'var(--font-md)',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            Annuler
          </button>
          <button onClick={() => onCreate(selectedKey, customTitle.trim() || undefined)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{
              background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
              color: '#fff', border: 'none',
            }}>
            Créer
          </button>
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// ConscienceGoalsModal — import sélectif depuis les goals Conscience
// ════════════════════════════════════════════════════════════════════════

function ConscienceGoalsModal({
  goals, loading, onCancel, onImport,
}: {
  goals: ConscienceGoalT[]
  loading: boolean
  onCancel: () => void
  onImport: (ids: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Par défaut, on coche les goals non encore importés
    return new Set(goals.filter(g => !g.imported).map(g => g.id))
  })
  useEffect(() => {
    // Resynchro si les goals changent (chargement tardif)
    setSelected(new Set(goals.filter(g => !g.imported).map(g => g.id)))
  }, [goals])

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectable = goals.filter(g => !g.imported)
  const selectedCount = Array.from(selected).filter(id =>
    selectable.some(g => g.id === id)
  ).length

  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, minWidth: 520, maxWidth: 720, width: '90%',
        maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <h2 style={{ fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0,
            display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sparkles className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
            Importer des objectifs Conscience
          </h2>
          <button onClick={onCancel} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', padding: 4,
          }}><X className="w-4 h-4" /></button>
        </div>
        <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
          Chaque objectif sélectionné devient une carte dans le projet actif, avec le
          tag <code style={{ color: 'var(--scarlet)' }}>conscience</code>. Les imports
          sont dédupliqués — un même objectif ne crée pas de doublon.
        </p>
        <div style={{
          flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6,
          paddingRight: 4, marginBottom: 12,
        }}>
          {loading && (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
              <Loader2 className="w-4 h-4 inline-block animate-spin" /> Chargement…
            </div>
          )}
          {!loading && goals.length === 0 && (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>
              Aucun objectif dans la Conscience — génère-en depuis le panneau Conscience.
            </div>
          )}
          {!loading && goals.map(g => {
            const sel = selected.has(g.id)
            return (
              <button key={g.id}
                onClick={() => !g.imported && toggle(g.id)}
                disabled={g.imported}
                style={{
                  textAlign: 'left', padding: '10px 12px', borderRadius: 8,
                  background: g.imported
                    ? 'color-mix(in srgb, var(--text-muted) 8%, transparent)'
                    : sel ? 'color-mix(in srgb, var(--scarlet) 10%, var(--bg-tertiary))'
                    : 'var(--bg-tertiary)',
                  border: `1px solid ${g.imported ? 'var(--border)'
                    : sel ? 'color-mix(in srgb, var(--scarlet) 40%, transparent)'
                    : 'var(--border)'}`,
                  color: 'var(--text-primary)',
                  cursor: g.imported ? 'not-allowed' : 'pointer', opacity: g.imported ? 0.55 : 1,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                    border: `1.5px solid ${sel ? 'var(--scarlet)' : 'var(--border)'}`,
                    background: sel ? 'var(--scarlet)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {sel && <Check className="w-2.5 h-2.5" style={{ color: '#fff' }} strokeWidth={3} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 'var(--font-md)', fontWeight: 600, marginBottom: 2,
                      color: 'var(--text-primary)',
                    }}>
                      {g.title}
                      <span style={{
                        marginLeft: 8, padding: '1px 6px', borderRadius: 4,
                        fontSize: 'var(--font-2xs)', fontWeight: 600, textTransform: 'uppercase',
                        background: 'var(--bg-primary)', color: 'var(--text-muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                      }}>
                        {g.status}
                      </span>
                      {g.imported && (
                        <span style={{
                          marginLeft: 4, padding: '1px 6px', borderRadius: 4,
                          fontSize: 'var(--font-2xs)', fontWeight: 600,
                          background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)',
                          color: 'var(--scarlet)',
                        }}>
                          Déjà importé
                        </span>
                      )}
                    </div>
                    {g.description && (
                      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                        {g.description}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginRight: 'auto' }}>
            {selectedCount} / {selectable.length} sélectionné{selectedCount > 1 ? 's' : ''}
          </span>
          <button onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            Annuler
          </button>
          <button
            onClick={() => onImport(Array.from(selected))}
            disabled={selectedCount === 0}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
            style={{
              background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
              color: '#fff', border: 'none',
              cursor: selectedCount > 0 ? 'pointer' : 'not-allowed',
            }}>
            Importer {selectedCount > 0 ? `(${selectedCount})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// RemindersPanel — panneau deadlines (overdue + today + soon)
// ════════════════════════════════════════════════════════════════════════

function RemindersPanel({
  reminders, onGotoCard, onClose, onDismiss,
}: {
  reminders: RemindersT
  onGotoCard: (projectId: number, cardId: number) => void
  onClose: () => void
  onDismiss: () => void
}) {
  const Section = ({ title, items, tone }: {
    title: string; items: ReminderItemT[]; tone: 'danger' | 'warn' | 'ok'
  }) => {
    if (items.length === 0) return null
    const color = tone === 'danger' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : '#10b981'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          fontSize: 'var(--font-xs)', fontFamily: 'JetBrains Mono, monospace',
          textTransform: 'uppercase', letterSpacing: 2,
          color, display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <AlertTriangle className="w-3 h-3" /> {title} · {items.length}
        </div>
        {items.map(r => (
          <button key={r.id}
            onClick={() => onGotoCard(r.project_id, r.id)}
            style={{
              textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 6,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', cursor: 'pointer', fontSize: 'var(--font-sm)',
            }}
            onMouseOver={e => { e.currentTarget.style.borderColor = color }}
            onMouseOut={e => { e.currentTarget.style.borderColor = 'var(--border)' }}>
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
              background: `color-mix(in srgb, ${color} 18%, transparent)`, color,
              fontFamily: 'JetBrains Mono, monospace', minWidth: 74, textAlign: 'center',
            }}>
              {r.days_diff < 0 ? `+${Math.abs(r.days_diff)}j retard`
                : r.days_diff === 0 ? "aujourd'hui"
                : `dans ${r.days_diff}j`}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{r.title}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                {r.project_title} · {r.due_date}
              </div>
            </div>
            <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="rounded-xl p-4" style={{
      background: 'var(--bg-secondary)',
      border: `1px solid ${reminders.overdue.length > 0 ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Bell className="w-4 h-4" style={{ color: reminders.overdue.length > 0 ? '#ef4444' : 'var(--scarlet)' }} />
          <span style={{ fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)' }}>
            Rappels deadlines
          </span>
          <span style={{
            fontSize: 'var(--font-xs)', fontFamily: 'JetBrains Mono, monospace',
            color: 'var(--text-muted)',
          }}>
            {reminders.total} carte{reminders.total > 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={onDismiss}
            style={{
              fontSize: 10.5, padding: '4px 10px', borderRadius: 6,
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}
            title="Ne plus afficher aujourd'hui">
            Ne plus afficher aujourd'hui
          </button>
          <button onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}
            title="Fermer"><X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} /></button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Section title="En retard" items={reminders.overdue} tone="danger" />
        <Section title="Aujourd'hui" items={reminders.today} tone="warn" />
        <Section title="Cette semaine" items={reminders.soon} tone="ok" />
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// BulkActionsBar — barre flottante en bas en mode multi-sélection
// ════════════════════════════════════════════════════════════════════════

function BulkActionsBar({
  count, archivedMode, statuses,
  onArchive, onRestore, onDelete, onSetStatus, onAddTag, onClear,
}: {
  count: number
  archivedMode: boolean
  statuses: StatusT[]
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  onSetStatus: (key: string) => void
  onAddTag: (tag: string) => void
  onClear: () => void
}) {
  const [statusOpen, setStatusOpen] = useState(false)
  const [tagInput, setTagInput] = useState('')
  return (
    <div style={{
      position: 'sticky', top: 12, zIndex: 10,
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 12px', borderRadius: 10,
      background: 'color-mix(in srgb, var(--scarlet) 8%, var(--bg-secondary))',
      border: '1px solid color-mix(in srgb, var(--scarlet) 40%, var(--border))',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    }}>
      <span style={{
        fontSize: 'var(--font-sm)', fontWeight: 700, color: 'var(--scarlet)',
        padding: '2px 8px', borderRadius: 4,
        background: 'color-mix(in srgb, var(--scarlet) 14%, transparent)',
      }}>
        {count} sélectionné{count > 1 ? 's' : ''}
      </span>
      {!archivedMode && (
        <>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setStatusOpen(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', cursor: 'pointer',
              }}>
              Changer statut <ChevronDown className="w-3 h-3" />
            </button>
            {statusOpen && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                minWidth: 160, background: 'var(--bg-secondary)',
                border: '1px solid var(--border)', borderRadius: 8,
                padding: 4, zIndex: 20,
                boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
              }}>
                {statuses.map(s => (
                  <button key={s.key}
                    onClick={() => { onSetStatus(s.key); setStatusOpen(false) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      width: '100%', textAlign: 'left',
                      padding: '5px 8px', borderRadius: 6,
                      background: 'transparent', color: 'var(--text-primary)',
                      border: 'none', cursor: 'pointer', fontSize: 'var(--font-xs)',
                    }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color }} />
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && tagInput.trim()) {
                  onAddTag(tagInput.trim()); setTagInput('')
                }
              }}
              placeholder="Ajouter tag…"
              style={{
                fontSize: 'var(--font-xs)', padding: '4px 8px', borderRadius: 6,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', outline: 'none', width: 120,
              }}
            />
            <button
              onClick={() => { if (tagInput.trim()) { onAddTag(tagInput.trim()); setTagInput('') } }}
              disabled={!tagInput.trim()}
              style={{
                fontSize: 'var(--font-xs)', padding: '4px 8px', borderRadius: 6,
                background: tagInput.trim() ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                color: tagInput.trim() ? '#fff' : 'var(--text-muted)',
                cursor: tagInput.trim() ? 'pointer' : 'not-allowed',
              }}>
              <Plus className="w-3 h-3" />
            </button>
          </div>
          <button onClick={onArchive}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
              color: '#f59e0b', cursor: 'pointer',
            }}>
            <Archive className="w-3 h-3" /> Archiver
          </button>
        </>
      )}
      {archivedMode && (
        <button onClick={onRestore}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
            background: 'var(--bg-tertiary)',
            border: '1px solid color-mix(in srgb, var(--scarlet) 35%, var(--border))',
            color: 'var(--scarlet)', cursor: 'pointer', fontWeight: 600,
          }}>
          <RotateCcw className="w-3 h-3" /> Restaurer
        </button>
      )}
      <button onClick={onDelete}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          color: '#ef4444', cursor: 'pointer',
        }}>
        <Trash2 className="w-3 h-3" /> Supprimer
      </button>
      <button onClick={onClear}
        style={{
          marginLeft: 'auto',
          fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
          background: 'transparent', border: '1px solid var(--border)',
          color: 'var(--text-muted)', cursor: 'pointer',
        }}>
        Annuler
      </button>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// ShortcutsModal — cheat-sheet des raccourcis clavier
// ════════════════════════════════════════════════════════════════════════

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['N',         "Focus la saisie « nouvelle carte »"],
    ['/',         'Focus la recherche'],
    ['S',         'Active/désactive la sélection multiple'],
    ['A',         'Bascule vers la vue archives'],
    ['Escape',    'Ferme la recherche / sort du mode sélection / annule les filtres'],
    ['?',         "Affiche ce panneau d'aide"],
    ['Ctrl+Z',    'Annule la dernière action (archive, suppression, changement de statut)'],
  ]
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, minWidth: 420, maxWidth: 520, width: '90%',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{
            fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Keyboard className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
            Raccourcis clavier
          </h2>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', padding: 4,
          }}><X className="w-4 h-4" /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(([k, desc]) => (
            <div key={k} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 10px', borderRadius: 6,
              background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            }}>
              <kbd style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 'var(--font-xs)', padding: '2px 8px', borderRadius: 4,
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                color: 'var(--scarlet)', fontWeight: 700, minWidth: 64, textAlign: 'center',
              }}>{k}</kbd>
              <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)' }}>{desc}</span>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 12, textAlign: 'center' }}>
          Les raccourcis s'activent en dehors des champs de saisie.
        </p>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// SortMenu — choix du critère de tri de la grille
// ════════════════════════════════════════════════════════════════════════

function SortMenu({
  sortBy, onChange,
}: {
  sortBy: 'position' | 'due_asc' | 'due_desc' | 'title_asc' | 'progress_desc' | 'recent'
  onChange: (v: any) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [open])
  const options: Array<[typeof sortBy, string]> = [
    ['position', 'Ordre manuel'],
    ['due_asc', 'Deadline ↑'],
    ['due_desc', 'Deadline ↓'],
    ['title_asc', 'Titre A-Z'],
    ['progress_desc', 'Progression ↓'],
    ['recent', 'Récemment modifiées'],
  ]
  const current = options.find(o => o[0] === sortBy)?.[1] || 'Trier'
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
        style={{
          background: sortBy !== 'position' ? 'color-mix(in srgb, var(--scarlet) 10%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
          border: '1px solid var(--border)',
          color: sortBy !== 'position' ? 'var(--scarlet)' : 'var(--text-secondary)',
        }}
        title="Trier la grille">
        <ArrowUpDown className="w-3.5 h-3.5" /> {current}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0,
          minWidth: 180, background: 'var(--bg-secondary)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: 4, zIndex: 20,
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
        }}>
          {options.map(([k, label]) => (
            <button key={k}
              onClick={() => { onChange(k); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', borderRadius: 6,
                background: k === sortBy ? 'color-mix(in srgb, var(--scarlet) 12%, transparent)' : 'transparent',
                color: k === sortBy ? 'var(--scarlet)' : 'var(--text-primary)',
                border: 'none', cursor: 'pointer', fontSize: 'var(--font-sm)',
              }}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// CalendarView — vues jour / semaine / mois, cartes placées par due_date
// ════════════════════════════════════════════════════════════════════════

type CalendarMode = 'day' | 'week' | 'month'

function CalendarView({
  cards, statuses, onOpenCard, onQuickCreate, onDayClick,
}: {
  cards: CardT[]
  statuses: StatusT[]
  onOpenCard: (cardId: number) => void
  onQuickCreate: (isoDate: string) => void
  onDayClick?: (isoDate: string) => void
}) {
  const [mode, setMode] = useState<CalendarMode>('month')
  // Curseur unique en Date — utilisé par les 3 modes (jour/semaine/mois) en
  // se calant sur le jour, le lundi de la semaine, ou le 1er du mois.
  const [cursorDate, setCursorDate] = useState<Date>(() => {
    const n = new Date(); n.setHours(0, 0, 0, 0); return n
  })

  // Index cartes par date ISO
  const byDate = useMemo(() => {
    const idx: Record<string, CardT[]> = {}
    for (const c of cards) {
      if (!c.due_date) continue
      ;(idx[c.due_date] ||= []).push(c)
    }
    return idx
  }, [cards])
  const statusColor = (key: string) =>
    statuses.find(s => s.key === key)?.color || 'var(--scarlet)'
  // ISO LOCALE — toIsoString() retourne du UTC, donc à minuit en heure locale
  // on tombe sur la VEILLE en UTC (ex: 2026-04-26 00:00 Europe/Paris = 2026-04-25 22:00 UTC).
  // Ça décalait la cellule « aujourd'hui » d'un jour. On reconstruit à la main
  // depuis getFullYear/getMonth/getDate qui sont en heure locale.
  const isoOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayIso = isoOf(today)

  // Helpers de navigation selon le mode
  const goPrev = () => {
    setCursorDate(d => {
      const n = new Date(d)
      if (mode === 'day') n.setDate(n.getDate() - 1)
      else if (mode === 'week') n.setDate(n.getDate() - 7)
      else n.setMonth(n.getMonth() - 1)
      return n
    })
  }
  const goNext = () => {
    setCursorDate(d => {
      const n = new Date(d)
      if (mode === 'day') n.setDate(n.getDate() + 1)
      else if (mode === 'week') n.setDate(n.getDate() + 7)
      else n.setMonth(n.getMonth() + 1)
      return n
    })
  }
  const goToday = () => {
    const n = new Date(); n.setHours(0, 0, 0, 0); setCursorDate(n)
  }

  // Label dynamique selon le mode
  const cursorLabel = (() => {
    if (mode === 'day') {
      return cursorDate.toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      })
    }
    if (mode === 'week') {
      // Lundi de la semaine
      const monday = new Date(cursorDate)
      const dow = (monday.getDay() + 6) % 7
      monday.setDate(monday.getDate() - dow)
      const sunday = new Date(monday)
      sunday.setDate(sunday.getDate() + 6)
      const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
      return `Semaine du ${fmt(monday)} au ${fmt(sunday)} ${sunday.getFullYear()}`
    }
    return cursorDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
  })()

  // Bouton de mode commun
  const ModeBtn = ({ id, label }: { id: CalendarMode; label: string }) => (
    <button onClick={() => setMode(id)}
      style={{
        padding: '4px 10px', borderRadius: 6, fontSize: 'var(--font-sm)',
        background: mode === id ? 'color-mix(in srgb, var(--scarlet) 18%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
        border: `1px solid ${mode === id ? 'color-mix(in srgb, var(--scarlet) 35%, transparent)' : 'var(--border)'}`,
        color: mode === id ? 'var(--scarlet)' : 'var(--text-secondary)',
        fontWeight: mode === id ? 700 : 500, cursor: 'pointer',
      }}>{label}</button>
  )

  // Header commun aux 3 modes
  const Header = (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 10, gap: 8, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <CalendarDays className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
        <span style={{ fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'capitalize' }}>
          {cursorLabel}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 2, marginRight: 4 }}>
          <ModeBtn id="day" label="Jour" />
          <ModeBtn id="week" label="Semaine" />
          <ModeBtn id="month" label="Mois" />
        </div>
        <button onClick={goPrev}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 'var(--font-sm)',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>←</button>
        <button onClick={goToday}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 'var(--font-sm)',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>Aujourd'hui</button>
        <button onClick={goNext}
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 'var(--font-sm)',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>→</button>
      </div>
    </div>
  )

  // Cellule d'une carte (réutilisée par les 3 vues, taille variable)
  // Clic sur une carte = filtrer la grille sur cette date (intent attendu :
  // « je veux voir les cartes de ce jour »). On n'ouvre PAS la carte ici —
  // l'user verra la liste filtrée et pourra ouvrir n'importe laquelle dans
  // la grille. Pas de stopPropagation donc le clic « bubble » jusqu'à la
  // cellule parent, qui appelle onDayClick (effet identique).
  const renderCard = (c: CardT, iso: string, opts: { size: 'sm' | 'md' | 'lg' }) => {
    const c_color = statusColor(c.status_key)
    const isOverdue = c.status_key !== 'done' && iso < todayIso
    const fontSize = opts.size === 'lg' ? 13 : opts.size === 'md' ? 11 : 10
    const padding = opts.size === 'lg' ? '6px 10px' : '2px 4px'
    return (
      <div key={c.id}
        style={{
          textAlign: 'left', fontSize, padding, borderRadius: 4,
          background: isOverdue ? 'rgba(239,68,68,0.15)' : `color-mix(in srgb, ${c_color} 12%, transparent)`,
          borderLeft: `2px solid ${isOverdue ? '#ef4444' : c_color}`,
          borderLeftWidth: opts.size === 'lg' ? 3 : 2, borderLeftStyle: 'solid',
          color: 'var(--text-primary)', cursor: 'pointer',
          whiteSpace: opts.size === 'lg' ? 'normal' : 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}
        title={`${c.title} · ${statuses.find(s => s.key === c.status_key)?.label || c.status_key}`}>
        {opts.size === 'lg' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 600 }}>{c.title}</span>
            {c.subtitle && <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{c.subtitle}</span>}
          </div>
        ) : c.title}
      </div>
    )
  }

  // Header d'une cellule : numéro cliquable (filtre date — fallback robuste
  // si la cellule parent n'attrape pas le clic) + bouton + (quick create).
  const renderDayHeader = (d: Date, opts: { highlight?: boolean; large?: boolean } = {}) => {
    const iso = isoOf(d)
    const isToday = iso === todayIso
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: opts.large ? 12 : 10, fontFamily: 'JetBrains Mono, monospace',
        color: isToday ? 'var(--scarlet)' : 'var(--text-muted)',
        fontWeight: isToday ? 700 : 500,
      }}>
        <button
          onClick={(e) => { e.stopPropagation(); onDayClick?.(iso) }}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            color: 'inherit', font: 'inherit',
            cursor: onDayClick ? 'pointer' : 'default',
            textDecoration: onDayClick ? 'underline dotted' : 'none',
            textUnderlineOffset: 2,
          }}
          title={onDayClick ? 'Filtrer la grille sur ce jour' : ''}>
          {opts.large ? d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) : d.getDate()}
        </button>
        <button onClick={(e) => { e.stopPropagation(); onQuickCreate(iso) }}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: 0, color: 'var(--text-muted)', opacity: 0.4,
          }}
          onMouseOver={e => { e.currentTarget.style.opacity = '1' }}
          onMouseOut={e => { e.currentTarget.style.opacity = '0.4' }}
          title="Créer une carte pour ce jour">
          <Plus className="w-3 h-3" />
        </button>
      </div>
    )
  }

  // ── Vue JOUR : liste verticale détaillée ─────────────────────────────
  if (mode === 'day') {
    const iso = isoOf(cursorDate)
    const dayCards = byDate[iso] || []
    return (
      <div className="rounded-xl p-4" style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      }}>
        {Header}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6,
          padding: 12, borderRadius: 8,
          background: 'var(--bg-tertiary)',
          border: `1px solid ${iso === todayIso ? 'var(--scarlet)' : 'var(--border)'}`,
        }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={() => onQuickCreate(iso)}
              style={{
                background: 'transparent', border: '1px dashed var(--border)',
                borderRadius: 6, padding: '4px 10px', fontSize: 'var(--font-xs)',
                color: 'var(--text-muted)', cursor: 'pointer',
              }}>
              <Plus className="w-3 h-3 inline mr-1" /> Nouvelle carte ce jour
            </button>
          </div>
          {dayCards.length === 0 ? (
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', padding: 20 }}>
              Aucune carte pour cette journée.
            </div>
          ) : (
            dayCards.map(c => renderCard(c, iso, { size: 'lg' }))
          )}
        </div>
      </div>
    )
  }

  // ── Vue SEMAINE : 7 colonnes lundi → dimanche ─────────────────────────
  if (mode === 'week') {
    const monday = new Date(cursorDate)
    const dow = (monday.getDay() + 6) % 7
    monday.setDate(monday.getDate() - dow)
    monday.setHours(0, 0, 0, 0)
    const days = Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(monday); d.setDate(monday.getDate() + i); return d
    })
    return (
      <div className="rounded-xl p-4" style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      }}>
        {Header}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4,
        }}>
          {days.map(d => {
            const iso = isoOf(d)
            const dayCards = byDate[iso] || []
            const isToday = iso === todayIso
            return (
              <div key={iso}
                onClick={() => onDayClick?.(iso)}
                style={{
                  background: 'var(--bg-tertiary)',
                  border: `1px solid ${isToday ? 'var(--scarlet)' : 'var(--border)'}`,
                  borderRadius: 6, padding: 6,
                  display: 'flex', flexDirection: 'column', gap: 4,
                  minHeight: 220,
                  cursor: onDayClick ? 'pointer' : 'default',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseOver={onDayClick ? (e) => {
                  e.currentTarget.style.background = 'color-mix(in srgb, var(--scarlet) 6%, var(--bg-tertiary))'
                  e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--scarlet) 35%, var(--border))'
                } : undefined}
                onMouseOut={onDayClick ? (e) => {
                  e.currentTarget.style.background = 'var(--bg-tertiary)'
                  e.currentTarget.style.borderColor = isToday ? 'var(--scarlet)' : 'var(--border)'
                } : undefined}
                title={onDayClick ? `Filtrer la grille sur ${d.toLocaleDateString('fr-FR')}` : ''}>
                {renderDayHeader(d, { large: true })}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, overflow: 'auto', flex: 1 }}>
                  {dayCards.map(c => renderCard(c, iso, { size: 'md' }))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Vue MOIS : grille 7×N (par défaut) ────────────────────────────────
  const cy = cursorDate.getFullYear()
  const cm = cursorDate.getMonth()
  const firstDay = new Date(cy, cm, 1)
  const lastDay = new Date(cy, cm + 1, 0)
  const firstCol = ((firstDay.getDay() + 6) % 7)
  const daysInMonth = lastDay.getDate()
  const totalCells = Math.ceil((firstCol + daysInMonth) / 7) * 7
  const cellIso = (day: number) =>
    `${cy}-${String(cm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  return (
    <div className="rounded-xl p-4" style={{
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    }}>
      {Header}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4,
        marginBottom: 4,
      }}>
        {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map(d => (
          <div key={d} style={{
            fontSize: 'var(--font-xs)', fontFamily: 'JetBrains Mono, monospace',
            textTransform: 'uppercase', letterSpacing: 2,
            color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0',
          }}>{d}</div>
        ))}
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        gridAutoRows: 110, gap: 4,
      }}>
        {Array.from({ length: totalCells }).map((_, i) => {
          const dayNum = i - firstCol + 1
          const inMonth = dayNum >= 1 && dayNum <= daysInMonth
          const iso = inMonth ? cellIso(dayNum) : ''
          const dayCards = inMonth ? (byDate[iso] || []) : []
          const isToday = iso === todayIso
          const isClickable = inMonth && !!onDayClick
          return (
            <div key={i}
              onClick={isClickable ? () => onDayClick!(iso) : undefined}
              style={{
                background: inMonth ? 'var(--bg-tertiary)' : 'transparent',
                border: `1px solid ${isToday ? 'var(--scarlet)' : 'var(--border)'}`,
                borderRadius: 6, padding: 4, opacity: inMonth ? 1 : 0.3,
                display: 'flex', flexDirection: 'column', gap: 2,
                minHeight: 0, overflow: 'hidden',
                position: 'relative',
                cursor: isClickable ? 'pointer' : 'default',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onMouseOver={isClickable ? (e) => {
                e.currentTarget.style.background = 'color-mix(in srgb, var(--scarlet) 6%, var(--bg-tertiary))'
                e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--scarlet) 35%, var(--border))'
              } : undefined}
              onMouseOut={isClickable ? (e) => {
                e.currentTarget.style.background = 'var(--bg-tertiary)'
                e.currentTarget.style.borderColor = isToday ? 'var(--scarlet)' : 'var(--border)'
              } : undefined}
              title={isClickable ? `Filtrer la grille sur le ${dayNum}` : ''}>

              {inMonth && (
                <>
                  {renderDayHeader(new Date(cy, cm, dayNum))}
                  <div style={{
                    flex: 1, display: 'flex', flexDirection: 'column', gap: 2,
                    overflow: 'hidden',
                  }}>
                    {dayCards.slice(0, 3).map(c => renderCard(c, iso, { size: 'sm' }))}
                    {dayCards.length > 3 && (
                      <span style={{
                        fontSize: 'var(--font-2xs)', color: 'var(--text-muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                      }}>+{dayCards.length - 3} autre{dayCards.length - 3 > 1 ? 's' : ''}</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// ImportModal — upload / paste + choix de format
// ════════════════════════════════════════════════════════════════════════

function ImportModal({
  onCancel, onImport,
}: {
  onCancel: () => void
  onImport: (format: 'json' | 'csv' | 'markdown', data: string) => void | Promise<void>
}) {
  const [format, setFormat] = useState<'json' | 'csv' | 'markdown'>('json')
  const [data, setData] = useState('')
  const [busy, setBusy] = useState(false)
  const onFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const txt = String(reader.result || '')
      setData(txt)
      // Auto-détection simple via extension
      const name = file.name.toLowerCase()
      if (name.endsWith('.json')) setFormat('json')
      else if (name.endsWith('.csv')) setFormat('csv')
      else if (name.endsWith('.md') || name.endsWith('.markdown')) setFormat('markdown')
    }
    reader.readAsText(file)
  }
  const samples: Record<string, string> = {
    json: '[{"title": "Tâche 1", "status_key": "todo", "tags": ["urgent"]}]',
    csv: 'title,status,tags,due_date\nTâche 1,todo,urgent|perso,2026-04-25',
    markdown: '# À faire\n- Première tâche\n  - sous-étape 1\n  - sous-étape 2\n- Deuxième tâche\n\n# Fait\n- Tâche déjà terminée',
  }
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, minWidth: 560, maxWidth: 720, width: '92%',
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{
            fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Upload className="w-4 h-4" style={{ color: 'var(--scarlet)' }} /> Importer des cartes
          </h2>
          <button onClick={onCancel}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}
            title="Fermer"><X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} /></button>
        </div>
        <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
          Colle un contenu ou charge un fichier. Formats : <strong>JSON</strong> (array ou {`{cards: [...]}`}),
          <strong> CSV</strong> (header attendu : title, status, tags, due_date…),
          <strong> Markdown</strong> (<code># Statut</code> puis <code>- Carte</code>, <code>  - Sous-tâche</code>).
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {(['json', 'csv', 'markdown'] as const).map(f => (
            <button key={f}
              onClick={() => setFormat(f)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{
                background: format === f ? 'color-mix(in srgb, var(--scarlet) 14%, var(--bg-tertiary))' : 'var(--bg-tertiary)',
                border: `1px solid ${format === f ? 'color-mix(in srgb, var(--scarlet) 40%, transparent)' : 'var(--border)'}`,
                color: format === f ? 'var(--scarlet)' : 'var(--text-secondary)',
                cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 1,
              }}>
              {f}
            </button>
          ))}
          <button onClick={() => setData(samples[format])}
            style={{
              marginLeft: 'auto', fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
              background: 'transparent', border: '1px dashed var(--border)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}>
            Coller un exemple
          </button>
          <label style={{
            fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
            background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
            color: 'var(--text-secondary)', cursor: 'pointer',
          }}>
            Charger un fichier…
            <input type="file"
              accept=".json,.csv,.md,.markdown,.txt"
              onChange={e => {
                const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''
              }}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        <textarea
          value={data}
          onChange={e => setData(e.target.value)}
          placeholder={samples[format]}
          style={{
            flex: 1, minHeight: 240, resize: 'vertical',
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 10,
            fontSize: 'var(--font-sm)', color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            Annuler
          </button>
          <button
            onClick={async () => {
              if (!data.trim() || busy) return
              setBusy(true)
              try { await onImport(format, data) } finally { setBusy(false) }
            }}
            disabled={!data.trim() || busy}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40"
            style={{
              background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
              color: '#fff', border: 'none',
              cursor: data.trim() && !busy ? 'pointer' : 'not-allowed',
            }}>
            {busy
              ? <><Loader2 className="w-3 h-3 animate-spin inline" /> Import…</>
              : 'Importer'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// Toast — feedback global non bloquant (bas de page)
// ════════════════════════════════════════════════════════════════════════

function Toast({
  toast, onClose,
}: {
  toast: { message: string; action?: { label: string; run: () => void }; key: number }
  onClose: () => void
}) {
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      zIndex: 200, minWidth: 320, maxWidth: 520,
      padding: '12px 16px', borderRadius: 10,
      background: 'var(--bg-secondary)',
      border: '1px solid color-mix(in srgb, var(--scarlet) 30%, var(--border))',
      boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', gap: 12,
      animation: 'none',
    }}>
      <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-primary)', flex: 1, lineHeight: 1.4 }}>
        {toast.message}
      </span>
      {toast.action && (
        <button
          onClick={() => { toast.action!.run(); onClose() }}
          style={{
            fontSize: 'var(--font-xs)', padding: '4px 10px', borderRadius: 6,
            background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
            color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600,
            whiteSpace: 'nowrap',
          }}>
          {toast.action.label}
        </button>
      )}
      <button onClick={onClose}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}>
        <X className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
      </button>
    </div>
  )
}
