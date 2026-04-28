/**
 * Gungnir Plugin — Forge v0.1.0
 *
 * Orchestrateur de workflows visuels (concurrent open-source de N8N/Hermès).
 *
 * MVP Phase 1 : éditeur YAML CodeMirror + liste workflows + run synchrone
 * + historique des runs. Le canvas React Flow arrive en Phase 3 — il
 * sérialisera vers le même YAML, donc l'éditeur texte restera la single
 * source of truth.
 *
 * Le runner backend exécute les steps en appelant les outils WOLF (~130
 * tools auto-découverts depuis tous les plugins). N'importe quel agent_tool
 * exposé peut devenir un node de workflow.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { yaml as yamlLang } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { Hammer, Workflow, Plus, Play, Trash2, RefreshCw, ChevronRight, Clock, Zap, AlertCircle, CheckCircle2, FileText, Code as CodeIcon, GitBranch, Upload, Download, Link as LinkIcon, Copy, X, Sparkles, History, RotateCcw, BookmarkPlus, Store, Star, Send, FlaskConical, Users, UserPlus } from 'lucide-react'
import { PageHeader, TabBar, PrimaryButton, SecondaryButton } from '@core/components/ui'
import InfoButton from '@core/components/InfoButton'
import { apiFetch } from '@core/services/api'
import { ForgeCanvas, type ForgeTool as CanvasForgeTool } from './Canvas'
import { humanizeTool, groupByCategory } from './toolLabels'

const PLUGIN_VERSION = '0.14.0'
const API = '/api/plugins/forge'

// ── Types ────────────────────────────────────────────────────────────────

interface ForgeWorkflow {
  id: number
  name: string
  description: string
  yaml_def: string
  enabled: boolean
  tags: string[]
  folder: string
  created_at: string | null
  updated_at: string | null
}

interface ForgeRunLog {
  ts: string
  step_id: string
  type: 'start' | 'end' | 'skip' | 'error'
  tool?: string
  ok?: boolean
  error?: string | null
  duration_ms?: number
  reason?: string
}

interface ForgeRun {
  id: number
  workflow_id: number
  status: 'running' | 'success' | 'error' | 'cancelled'
  inputs: Record<string, unknown>
  output: Record<string, unknown>
  logs: ForgeRunLog[]
  error: string
  trigger_source: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
}

interface ForgeTool {
  name: string
  description: string
  params: Array<{ name: string; type: string; description: string; required: boolean }>
}

interface ForgeTrigger {
  id: number
  workflow_id: number
  type: 'webhook' | 'cron' | 'manual'
  config: Record<string, any>
  enabled: boolean
  last_fire_at: string | null
  created_at: string | null
  webhook_url?: string
  secret_token?: string
}

interface ForgeVersion {
  id: number
  workflow_id: number
  version_num: number
  name: string
  description: string
  source: 'auto' | 'manual' | 'pre_restore'
  message: string
  created_at: string | null
}

const TABS = [
  { key: 'workflows' as const, label: 'Workflows', icon: <Workflow size={14} /> },
  { key: 'templates' as const, label: 'Templates', icon: <Sparkles size={14} /> },
  { key: 'marketplace' as const, label: 'Marketplace', icon: <Store size={14} /> },
  { key: 'variables' as const, label: 'Variables', icon: <BookmarkPlus size={14} /> },
  { key: 'runs' as const, label: 'Historique', icon: <Clock size={14} /> },
  { key: 'tools' as const, label: 'Outils dispo', icon: <Zap size={14} /> },
]

// ── Autocomplete YAML ────────────────────────────────────────────────────
//
// Suggère les noms de wolf_tools après `tool: ` et un set de snippets
// pour les blocs courants (if, parallel, for_each, retry…). Allège
// drastiquement l'écriture YAML à la main sans avoir à mémoriser les
// 140+ noms d'outils.

const FORGE_YAML_SNIPPETS: Array<{ label: string; detail: string; insertText: string }> = [
  { label: 'if-', detail: 'Condition (saute si fausse)',
    insertText: 'if: "{{ steps.previous.ok }}"' },
  { label: 'parallel-', detail: 'Bloc parallèle (asyncio.gather)',
    insertText: 'parallel:\n  - tool: web_fetch\n    args: { url: "..." }\n  - tool: web_fetch\n    args: { url: "..." }' },
  { label: 'for_each-', detail: 'Boucle sur une liste',
    insertText: 'for_each: "{{ inputs.items }}"\nas: item\ndo:\n  - tool: web_fetch\n    args: { url: "{{ item }}" }' },
  { label: 'retry-', detail: 'Retry policy (count + delay)',
    insertText: 'retry: { count: 3, delay_ms: 1000, backoff: 2.0 }' },
  { label: 'continue_on_error-', detail: 'Continue si ce step échoue',
    insertText: 'continue_on_error: true' },
  { label: 'inputs-', detail: 'Section inputs au top-level',
    insertText: 'inputs:\n  url:\n    type: string\n    default: https://example.com' },
  { label: 'step-', detail: 'Step atomique avec id et tool',
    insertText: '- id: my_step\n  tool: web_fetch\n  args:\n    url: "{{ inputs.url }}"' },
]

function makeYamlCompletions(tools: CanvasForgeTool[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const lineFrom = ctx.state.doc.lineAt(ctx.pos)
    const lineText = lineFrom.text.slice(0, ctx.pos - lineFrom.from)
    // Match "tool: <partial>" → suggérer les noms de wolf_tools
    const toolMatch = lineText.match(/(^|[\s\-])tool:\s*([\w-]*)$/)
    if (toolMatch) {
      const startCol = ctx.pos - toolMatch[2].length
      return {
        from: startCol,
        options: tools.map(t => ({
          label: t.name,
          detail: t.description.slice(0, 60),
          type: 'function',
          info: t.description,
        })),
        validFor: /^[\w-]*$/,
      }
    }
    // Sinon, snippets en début de ligne ou après un tiret de liste
    const word = ctx.matchBefore(/[\w_-]+/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    return {
      from: word.from,
      options: FORGE_YAML_SNIPPETS.map(s => ({
        label: s.label,
        detail: s.detail,
        type: 'snippet',
        apply: s.insertText,
      })),
      validFor: /^[\w-]*$/,
    }
  }
}


// ── Helpers ──────────────────────────────────────────────────────────────

// Helper API : lève une Error visible (alert) sur échec pour pouvoir
// diagnostiquer en prod. Le `silent` permet aux fetchs de fond (load list)
// de ne pas spammer si le réseau hoquète.
async function api<T = any>(path: string, init?: RequestInit, silent = false): Promise<T | null> {
  const headers: Record<string, string> = { ...(init?.headers as any || {}) }
  // Force Content-Type pour les bodies JSON — certains backends refusent
  // sans (FastAPI accepte mais on est défensif).
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  try {
    const r = await apiFetch(`${API}${path}`, { ...init, headers })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      const msg = `[Forge] ${path} → HTTP ${r.status}\n${t.slice(0, 500)}`
      console.warn(msg)
      if (!silent) alert(msg)
      return null
    }
    return await r.json()
  } catch (e: any) {
    const msg = `[Forge] ${path} — réseau ou parse JSON : ${e?.message || e}`
    console.warn(msg, e)
    if (!silent) alert(msg)
    return null
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

export default function ForgePlugin() {
  const [tab, setTab] = useState<'workflows' | 'runs' | 'tools' | 'templates' | 'marketplace' | 'variables'>('workflows')

  // Auto-acceptance d'invitation : si l'URL contient ?invite=<token>,
  // on appelle l'endpoint accept et on redirige vers le workflow partagé.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('invite')
    if (!token) return
    (async () => {
      const preview = await api<{ ok: boolean; workflow_name?: string; role?: string; detail?: string }>(
        `/invites/${encodeURIComponent(token)}`, undefined, true,
      )
      if (!preview?.ok) {
        alert(`Invitation invalide : ${preview?.detail || 'token expiré ou consumé'}`)
        return
      }
      const ok = confirm(`Tu es invité à collaborer sur "${preview.workflow_name}" en tant que ${preview.role}. Accepter ?`)
      if (!ok) return
      const r = await api<{ ok: boolean; workflow_id: number; role: string; detail?: string }>(
        `/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' },
      )
      if (r?.ok) {
        alert(`Accès accordé (${r.role}). Le workflow apparaîtra dans ta liste.`)
        // Clean l'URL pour ne pas re-déclencher au refresh.
        const url = new URL(window.location.href)
        url.searchParams.delete('invite')
        window.history.replaceState({}, '', url.toString())
      } else {
        alert(`Acceptation échouée : ${r?.detail || 'erreur'}`)
      }
    })()
  }, [])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          icon={<Hammer size={18} />}
          title="Forge"
          version={PLUGIN_VERSION}
          subtitle={<span>Orchestrateur de workflows <InfoButton>
            <strong>Forge</strong> permet de chaîner des outils Gungnir (web fetch, valkyrie, kb, soul, channels…) en workflows YAML.
            <br /><br />
            Chaque step appelle un outil (~130 dispo). Les outputs alimentent les steps suivants via <code>{`{{ steps.X.output }}`}</code>. Conditions <code>if:</code> et blocs <code>parallel:</code> supportés.
            <br /><br />
            Phase 1 : éditeur YAML + run synchrone. Phase 3 : canvas React Flow visuel par-dessus le même YAML.
          </InfoButton></span> as any}
        />
      </div>
      <div style={{ padding: '0 24px 12px' }}>
        <TabBar tabs={TABS} active={tab} onChange={setTab} />
      </div>
      {tab === 'workflows' && <WorkflowsTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'marketplace' && <MarketplaceTab />}
      {tab === 'variables' && <VariablesTab />}
      {tab === 'runs' && <RunsTab />}
      {tab === 'tools' && <ToolsTab />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB — Workflows
// ═══════════════════════════════════════════════════════════════════════════════

function WorkflowsTab() {
  const [list, setList] = useState<ForgeWorkflow[]>([])
  const [active, setActive] = useState<ForgeWorkflow | null>(null)
  const [draft, setDraft] = useState<{ name: string; description: string; yaml_def: string; folder: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<ForgeRun | null>(null)
  const [loading, setLoading] = useState(true)
  // Vue active : YAML brut ou Canvas visuel. Préférence persistée pour
  // que l'user retrouve sa vue habituelle entre sessions.
  const [view, setView] = useState<'visual' | 'yaml'>(() => {
    try {
      const v = localStorage.getItem('forge_view_mode')
      return v === 'yaml' ? 'yaml' : 'visual'
    } catch { return 'visual' }
  })
  useEffect(() => {
    try { localStorage.setItem('forge_view_mode', view) } catch { /* ignore */ }
  }, [view])
  // Catalogue d'outils chargé une fois — partagé entre Canvas (palette +
  // metadata des nodes) et l'éventuel autocomplete YAML futur.
  const [tools, setTools] = useState<CanvasForgeTool[]>([])
  useEffect(() => {
    (async () => {
      const r = await api<{ ok: boolean; tools: CanvasForgeTool[] }>('/tools', undefined, true)
      setTools(r?.tools || [])
    })()
  }, [])

  // Panneau latéral droit : run / triggers / versions.
  const [rightPanel, setRightPanel] = useState<'run' | 'triggers' | 'versions'>('run')

  const load = useCallback(async () => {
    setLoading(true)
    // silent=true : pas d'alert au boot, juste un état vide si l'API
    // échoue (l'user verra "Aucun workflow" et pourra cliquer Nouveau
    // pour avoir l'erreur explicite).
    const r = await api<{ ok: boolean; workflows: ForgeWorkflow[] }>('/workflows', undefined, true)
    setList(r?.workflows || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Quand on sélectionne un workflow, on initialise le draft.
  useEffect(() => {
    if (active) {
      setDraft({ name: active.name, description: active.description, yaml_def: active.yaml_def, folder: active.folder || '' })
      setLastRun(null)
    } else {
      setDraft(null)
    }
  }, [active])

  const handleCreate = async () => {
    const r = await api<{ ok: boolean; workflow: ForgeWorkflow }>('/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Nouveau workflow' }),
    })
    if (r?.workflow) { await load(); setActive(r.workflow) }
  }

  // Import depuis un fichier (YAML Forge ou JSON N8N — auto-détection backend).
  const handleImport = useCallback(async () => {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = '.yaml,.yml,.json,application/yaml,application/json'
    inp.onchange = async () => {
      const f = inp.files?.[0]
      if (!f) return
      const text = await f.text()
      const r = await api<{ ok: boolean; workflow_id: number; warnings: string[] }>('/workflows/import', {
        method: 'POST',
        body: JSON.stringify({ data: text }),
      })
      if (r?.workflow_id) {
        await load()
        if (r.warnings?.length) {
          alert(`Import réussi avec ${r.warnings.length} avertissement(s) :\n\n${r.warnings.slice(0, 8).join('\n')}`)
        }
        // Sélectionne le workflow importé.
        const wf = (await api<{ ok: boolean; workflow: ForgeWorkflow }>(`/workflows/${r.workflow_id}`, undefined, true))?.workflow
        if (wf) setActive(wf)
      }
    }
    inp.click()
  }, [load])

  // Export du workflow sélectionné en YAML (téléchargement).
  const handleExport = useCallback(async () => {
    if (!active) return
    const r = await api<{ ok: boolean; filename: string; yaml: string }>(`/workflows/${active.id}/export`)
    if (!r?.yaml) return
    const blob = new Blob([r.yaml], { type: 'application/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = r.filename || 'workflow.forge.yaml'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [active])

  const handleSave = async () => {
    if (!active || !draft) return
    const r = await api<{ ok: boolean; workflow?: ForgeWorkflow; detail?: string }>(`/workflows/${active.id}`, {
      method: 'PUT',
      body: JSON.stringify(draft),
    })
    if (r?.workflow) {
      await load()
      setActive(r.workflow)
    } else {
      alert(`Sauvegarde échouée${r?.detail ? ` : ${r.detail}` : ''}`)
    }
  }

  const handleDelete = async () => {
    if (!active) return
    if (!confirm(`Supprimer "${active.name}" et tous ses runs ?`)) return
    await api(`/workflows/${active.id}`, { method: 'DELETE' })
    setActive(null)
    await load()
  }

  // Run async + SSE streaming : on lance via /run-async (retour immédiat
  // avec un run_id), puis on consomme /runs/{id}/stream pour afficher
  // les events au fur et à mesure. À la fin, on récupère le run final
  // pour avoir l'output complet.
  const handleRun = async () => {
    if (!active || !draft) return
    if (draft.yaml_def !== active.yaml_def
        || draft.name !== active.name
        || draft.description !== active.description) {
      await handleSave()
    }
    setRunning(true)
    // On affiche un run "vide" en cours pour que l'UI réagisse direct.
    const liveRun: ForgeRun = {
      id: 0, workflow_id: active.id, status: 'running',
      inputs: {}, output: {}, logs: [], error: '',
      trigger_source: 'manual',
      started_at: new Date().toISOString(),
      finished_at: null, duration_ms: null,
    }
    setLastRun(liveRun)
    setRightPanel('run')

    const launch = await api<{ ok: boolean; run_id: number; detail?: string }>(
      `/workflows/${active.id}/run-async`,
      { method: 'POST', body: JSON.stringify({ inputs: {} }) },
    )
    if (!launch?.run_id) {
      setRunning(false)
      return
    }
    const runId = launch.run_id
    liveRun.id = runId
    setLastRun({ ...liveRun })

    // Stream SSE via fetch + ReadableStream (pas d'EventSource car il ne
    // supporte pas les headers Authorization).
    try {
      const headers: Record<string, string> = {}
      const token = localStorage.getItem('gungnir_auth_token')
      if (token) headers['Authorization'] = `Bearer ${token}`
      const resp = await fetch(`${API}/runs/${runId}/stream`, { headers, cache: 'no-store' })
      if (!resp.ok || !resp.body) throw new Error(`stream HTTP ${resp.status}`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const aggregateLogs: ForgeRunLog[] = []
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // Parse `data: ...\n\n` events.
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              const evt = JSON.parse(line.slice(5).trim())
              if (evt.type === 'run_start') {
                // rien — déjà initialisé
              } else if (evt.type === 'run_end') {
                // On va recharger l'état final via GET /runs/{id}
              } else if (evt.step_id) {
                aggregateLogs.push(evt as ForgeRunLog)
                setLastRun(prev => prev ? { ...prev, logs: [...aggregateLogs] } : prev)
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      console.warn('[Forge] stream failed', e)
    }

    // Final fetch — l'output complet n'est pas dans les events SSE.
    const final = await api<{ ok: boolean; run: ForgeRun }>(`/runs/${runId}`, undefined, true)
    if (final?.run) setLastRun(final.run)
    setRunning(false)
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      {/* Liste workflows */}
      <div style={{
        width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 12px', display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
          <PrimaryButton size="sm" icon={<Plus size={13} />} onClick={handleCreate}>Nouveau</PrimaryButton>
          <SecondaryButton size="sm" icon={<Upload size={13} />} onClick={handleImport}>Importer</SecondaryButton>
          <SecondaryButton size="sm" icon={<RefreshCw size={13} />} onClick={load}>Actualiser</SecondaryButton>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)' }}>Chargement…</div>
          : list.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)', lineHeight: 1.6 }}>
              Aucun workflow.<br />Cliquez sur <strong>Nouveau</strong> pour créer le premier.
            </div>
          : (() => {
              // Groupage par folder. Workflows sans folder → "(racine)".
              const byFolder = new Map<string, ForgeWorkflow[]>()
              for (const w of list) {
                const f = (w.folder || '').trim() || '(racine)'
                const arr = byFolder.get(f) || []
                arr.push(w); byFolder.set(f, arr)
              }
              const folders = Array.from(byFolder.entries()).sort(([a], [b]) => {
                if (a === '(racine)') return -1
                if (b === '(racine)') return 1
                return a.localeCompare(b)
              })
              return folders.map(([folder, items]) => (
                <div key={folder}>
                  {folders.length > 1 && (
                    <div style={{ padding: '6px 12px', fontSize: 'var(--font-2xs)', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)' }}>
                      {folder} <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>· {items.length}</span>
                    </div>
                  )}
                  {items.map(w => (
                    <div key={w.id} onClick={() => setActive(w)}
                      style={{
                        padding: '10px 14px', cursor: 'pointer',
                        borderBottom: '1px solid var(--border)',
                        background: active?.id === w.id ? 'rgba(220,38,38,0.12)' : 'transparent',
                        borderLeft: active?.id === w.id ? '3px solid var(--scarlet)' : '3px solid transparent',
                        transition: 'background 0.1s',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <Workflow size={12} style={{ color: w.enabled ? 'var(--scarlet)' : 'var(--text-muted)', flexShrink: 0 }} />
                        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                      </div>
                      {w.description && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.description}</div>}
                      <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                        {!w.enabled && <span style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', borderRadius: 3, background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>désactivé</span>}
                        {w.tags.slice(0, 3).map(t => <span key={t} style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', borderRadius: 3, background: 'rgba(220,38,38,0.18)', color: 'var(--scarlet)' }}>{t}</span>)}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            })()}
        </div>
      </div>

      {/* Éditeur + run panel */}
      {active && draft ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Header édition */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              placeholder="Nom du workflow"
              style={{ flex: 1, minWidth: 200, padding: '5px 10px', fontSize: 'var(--font-md)', fontWeight: 600, borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }}
            />
            {/* Toggle Vue Visuel ↔ YAML — les deux vues éditent le même
                yaml_def, donc switch instantané sans perte. */}
            <div style={{ display: 'flex', gap: 1, padding: 2, background: 'var(--bg-tertiary)', borderRadius: 5 }}>
              <button onClick={() => setView('visual')}
                title="Éditeur visuel (drag & drop)"
                style={{
                  padding: '4px 8px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer',
                  border: 'none', borderRadius: 3,
                  background: view === 'visual' ? 'var(--scarlet)' : 'transparent',
                  color: view === 'visual' ? '#fff' : 'var(--text-secondary)',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}>
                <GitBranch size={11} /> Visuel
              </button>
              <button onClick={() => setView('yaml')}
                title="Édition YAML"
                style={{
                  padding: '4px 8px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer',
                  border: 'none', borderRadius: 3,
                  background: view === 'yaml' ? 'var(--scarlet)' : 'transparent',
                  color: view === 'yaml' ? '#fff' : 'var(--text-secondary)',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}>
                <CodeIcon size={11} /> YAML
              </button>
            </div>
            <PrimaryButton size="sm" icon={<Play size={13} />} onClick={handleRun} disabled={running}>
              {running ? 'Exécution…' : 'Exécuter'}
            </PrimaryButton>
            <SecondaryButton size="sm" onClick={handleSave}>Sauvegarder</SecondaryButton>
            <SecondaryButton size="sm" icon={<Download size={13} />} onClick={handleExport}>Exporter</SecondaryButton>
            <SecondaryButton size="sm" icon={<UserPlus size={13} />} onClick={async () => {
              if (!active) return
              const role = window.prompt('Rôle de l\'invité (viewer / editor / admin)', 'editor') || 'editor'
              if (!['viewer', 'editor', 'admin'].includes(role)) {
                alert('Rôle invalide')
                return
              }
              const r = await api<{ ok: boolean; invite_url: string; expires_at: string }>(
                `/workflows/${active.id}/invite`,
                { method: 'POST', body: JSON.stringify({ role, expires_in_days: 7 }) },
              )
              if (r?.invite_url) {
                // L'URL pointe vers /forge/invite/{token} — on la convertit
                // pour pointer vers la SPA avec query param ?invite=token.
                const m = r.invite_url.match(/\/forge\/invite\/(.+)$/)
                const token = m ? m[1] : ''
                const spaUrl = `${window.location.origin}/plugins/forge?invite=${token}`
                navigator.clipboard.writeText(spaUrl).catch(() => {})
                alert(`Lien d'invitation (${role}) copié :\n\n${spaUrl}\n\nExpire le ${new Date(r.expires_at).toLocaleDateString('fr-FR')}`)
              }
            }}>Inviter</SecondaryButton>
            <SecondaryButton size="sm" icon={<Send size={13} />} onClick={async () => {
              if (!active) return
              const cat = window.prompt('Catégorie (Veille / Dev / Productivité / IA / Notifications / Autre)', 'Autre') || 'Autre'
              if (!confirm(`Publier "${active.name}" sur la Marketplace publique ?`)) return
              const r = await api<{ ok: boolean; marketplace_id: number }>('/marketplace/publish', {
                method: 'POST',
                body: JSON.stringify({
                  workflow_id: active.id, name: active.name,
                  description: active.description, category: cat,
                  tags: active.tags,
                }),
              })
              if (r?.marketplace_id) alert(`Workflow publié sur la Marketplace (#${r.marketplace_id}).`)
            }}>Publier</SecondaryButton>
            <SecondaryButton size="sm" danger icon={<Trash2 size={13} />} onClick={handleDelete}>Supprimer</SecondaryButton>
          </div>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
            <input
              value={draft.description}
              onChange={e => setDraft({ ...draft, description: e.target.value })}
              placeholder="Description (optionnelle)"
              style={{ flex: 1, padding: '6px 16px', fontSize: 'var(--font-xs)', background: 'transparent', border: 'none', color: 'var(--text-muted)', outline: 'none' }}
            />
            <input
              value={draft.folder}
              onChange={e => setDraft({ ...draft, folder: e.target.value })}
              placeholder="Dossier (ex: Veille/News)"
              title="Organise ce workflow dans un dossier (path-like, ex: Personnel/Daily)"
              style={{ width: 200, padding: '6px 16px', fontSize: 'var(--font-xs)', background: 'transparent', border: 'none', borderLeft: '1px solid var(--border)', color: 'var(--text-secondary)', outline: 'none', fontFamily: 'ui-monospace, monospace' }}
            />
          </div>

          {/* Vue éditeur (Canvas ou YAML) + panel logs côte à côte */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
              {view === 'visual' ? (
                <ForgeCanvas
                  yamlValue={draft.yaml_def}
                  tools={tools}
                  onChange={(yaml) => setDraft({ ...draft, yaml_def: yaml })}
                />
              ) : (
                <CodeMirror
                  value={draft.yaml_def}
                  theme={oneDark}
                  extensions={[
                    yamlLang(),
                    autocompletion({ override: [makeYamlCompletions(tools)] }),
                  ]}
                  onChange={v => setDraft({ ...draft, yaml_def: v })}
                  height="100%"
                  style={{ flex: 1, overflow: 'auto', height: '100%' }}
                  basicSetup={{
                    lineNumbers: true, foldGutter: true, highlightActiveLine: true,
                    bracketMatching: true, autocompletion: true, history: true,
                    indentOnInput: true, syntaxHighlighting: true, tabSize: 2,
                  }}
                />
              )}
            </div>

            {/* Panel droit : toggle Run ↔ Triggers */}
            <div style={{ width: 340, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
                {(['run', 'triggers', 'versions'] as const).map(k => (
                  <button key={k} onClick={() => setRightPanel(k)}
                    style={{
                      flex: 1, padding: '8px 10px', fontSize: 'var(--font-xs)', fontWeight: 700, letterSpacing: 1,
                      cursor: 'pointer', background: rightPanel === k ? 'var(--bg-primary)' : 'transparent',
                      color: rightPanel === k ? 'var(--scarlet)' : 'var(--text-muted)',
                      border: 'none', borderBottom: rightPanel === k ? '2px solid var(--scarlet)' : '2px solid transparent',
                      textTransform: 'uppercase',
                    }}>
                    {k === 'run' ? 'Exécution' : k === 'triggers' ? 'Déclencheurs' : 'Versions'}
                  </button>
                ))}
              </div>
              {rightPanel === 'run' ? (
                <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
                  {running && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)' }}>Exécution en cours…</div>}
                  {!running && !lastRun && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)', lineHeight: 1.6 }}>Cliquez <strong>Exécuter</strong> pour lancer ce workflow.</div>}
                  {lastRun && <RunDisplay run={lastRun} />}
                </div>
              ) : rightPanel === 'triggers' ? (
                <TriggersPanel workflowId={active.id} />
              ) : (
                <VersionsPanel workflowId={active.id}
                  onRestored={async () => {
                    // Recharge la liste + le workflow actif après restauration
                    await load()
                    const wf = (await api<{ ok: boolean; workflow: ForgeWorkflow }>(`/workflows/${active.id}`, undefined, true))?.workflow
                    if (wf) setActive(wf)
                  }} />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text-muted)', fontSize: 'var(--font-md)' }}>
          <FileText size={40} style={{ opacity: 0.3 }} />
          <div>Sélectionnez un workflow ou créez-en un nouveau</div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Composant — Versions (historique + restauration)
// ═══════════════════════════════════════════════════════════════════════════════

function VersionsPanel({ workflowId, onRestored }: {
  workflowId: number
  onRestored: () => void | Promise<void>
}) {
  const [versions, setVersions] = useState<ForgeVersion[]>([])
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ ok: boolean; versions: ForgeVersion[] }>(`/workflows/${workflowId}/versions`, undefined, true)
    setVersions(r?.versions || [])
    setLoading(false)
  }, [workflowId])
  useEffect(() => { load() }, [load])

  const snapshotNow = async () => {
    const msg = window.prompt('Message du snapshot (optionnel)', '') || ''
    const r = await api<{ ok: boolean; version: ForgeVersion }>(`/workflows/${workflowId}/versions`, {
      method: 'POST',
      body: JSON.stringify({ message: msg }),
    })
    if (r?.version) load()
  }

  const restore = async (v: ForgeVersion) => {
    if (!confirm(`Restaurer la version v${v.version_num} (${fmtDate(v.created_at)}) ?\n\nL'état actuel sera sauvegardé en snapshot 'pre_restore' pour pouvoir annuler.`)) return
    const r = await api<{ ok: boolean; restored_from_version: number }>(`/workflows/${workflowId}/versions/${v.id}/restore`, { method: 'POST' })
    if (r?.ok) {
      await load()
      await onRestored()
    }
  }

  const remove = async (v: ForgeVersion) => {
    if (!confirm(`Supprimer la version v${v.version_num} ?`)) return
    await api(`/workflows/${workflowId}/versions/${v.id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      <button onClick={snapshotNow}
        style={{ width: '100%', padding: '8px 10px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 14 }}>
        <BookmarkPlus size={13} /> Snapshot manuel
      </button>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8 }}>
        Snapshots auto-créés à chaque sauvegarde du YAML (rate limit 5 min).
        Cliquez "Restaurer" pour revenir à une version. L'état actuel sera
        snapshotté avant pour pouvoir annuler.
      </div>
      {loading && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>Chargement…</div>}
      {!loading && versions.length === 0 && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', fontStyle: 'italic', padding: '10px 4px' }}>
          Aucune version pour l'instant. Modifie ton workflow et sauvegarde, ou clique <strong>Snapshot manuel</strong>.
        </div>
      )}
      {versions.map(v => {
        const sourceColor = v.source === 'manual' ? '#10b981' : v.source === 'pre_restore' ? '#f59e0b' : '#737373'
        const sourceLabel = v.source === 'manual' ? 'manuel' : v.source === 'pre_restore' ? 'avant rollback' : 'auto'
        return (
          <div key={v.id} style={{ padding: 8, marginBottom: 6, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 5, borderLeft: `3px solid ${sourceColor}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ fontSize: 'var(--font-xs)', fontWeight: 700, color: 'var(--scarlet)', fontFamily: 'ui-monospace, monospace' }}>v{v.version_num}</span>
              <span style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', borderRadius: 3, background: `${sourceColor}25`, color: sourceColor, fontWeight: 600, textTransform: 'uppercase' }}>{sourceLabel}</span>
              <div style={{ flex: 1 }} />
              <button onClick={() => restore(v)} title="Restaurer"
                style={{ padding: 3, fontSize: 'var(--font-xs)', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                <RotateCcw size={11} />
              </button>
              <button onClick={() => remove(v)} title="Supprimer"
                style={{ padding: 3, fontSize: 'var(--font-xs)', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                <X size={11} />
              </button>
            </div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {v.name || <span style={{ color: 'var(--text-muted)' }}>—</span>}
            </div>
            {v.message && (
              <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>"{v.message}"</div>
            )}
            <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', marginTop: 3 }}>{fmtDate(v.created_at)}</div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Composant — Triggers (déclencheurs : webhook + cron)
// ═══════════════════════════════════════════════════════════════════════════════

function TriggersPanel({ workflowId }: { workflowId: number }) {
  const [triggers, setTriggers] = useState<ForgeTrigger[]>([])
  const [loading, setLoading] = useState(true)
  const [cronExpr, setCronExpr] = useState('0 9 * * *')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ ok: boolean; triggers: ForgeTrigger[] }>(`/workflows/${workflowId}/triggers`, undefined, true)
    setTriggers(r?.triggers || [])
    setLoading(false)
  }, [workflowId])

  useEffect(() => { load() }, [load])

  const addWebhook = async () => {
    const r = await api<{ ok: boolean; trigger: ForgeTrigger }>(`/workflows/${workflowId}/triggers`, {
      method: 'POST',
      body: JSON.stringify({ type: 'webhook', config: {} }),
    })
    if (r?.trigger) load()
  }

  const addCron = async () => {
    if (!cronExpr.trim()) return
    const r = await api<{ ok: boolean; trigger: ForgeTrigger }>(`/workflows/${workflowId}/triggers`, {
      method: 'POST',
      body: JSON.stringify({ type: 'cron', config: { expression: cronExpr.trim() } }),
    })
    if (r?.trigger) load()
  }

  const toggleTrigger = async (t: ForgeTrigger) => {
    const r = await api(`/triggers/${t.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !t.enabled, config: t.config }),
    })
    if (r) load()
  }

  const deleteTrigger = async (t: ForgeTrigger) => {
    if (!confirm(`Supprimer ce déclencheur ${t.type} ?`)) return
    const r = await api(`/triggers/${t.id}`, { method: 'DELETE' })
    if (r) load()
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      {/* Action : ajouter webhook */}
      <div style={{ padding: 10, marginBottom: 10, background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>WEBHOOK</div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
          Génère une URL publique. Un POST dessus lance le workflow ; le body devient les <code>inputs</code>.
        </div>
        <button onClick={addWebhook}
          style={{ padding: '4px 10px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Plus size={11} /> Ajouter
        </button>
      </div>

      {/* Action : ajouter cron */}
      <div style={{ padding: 10, marginBottom: 14, background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>CRON (PLANIFIÉ)</div>
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 6 }}>
          Expression cron (5 champs : min h jour mois jour-sem). Granularité 30s.
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <input value={cronExpr} onChange={e => setCronExpr(e.target.value)}
            placeholder="0 9 * * *"
            style={{ flex: 1, padding: '4px 6px', fontSize: 'var(--font-xs)', fontFamily: 'ui-monospace, monospace', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }} />
          <button onClick={addCron}
            style={{ padding: '4px 10px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Plus size={11} /> Ajouter
          </button>
        </div>
      </div>

      {/* Liste des triggers existants */}
      <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>ACTIFS ({triggers.length})</div>
      {loading && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>Chargement…</div>}
      {!loading && triggers.length === 0 && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', fontStyle: 'italic', padding: '10px 4px' }}>Aucun déclencheur. Ajoute un webhook pour exposer ce workflow à l'extérieur.</div>
      )}
      {triggers.map(t => <TriggerCard key={t.id} t={t} onToggle={() => toggleTrigger(t)} onDelete={() => deleteTrigger(t)} />)}
    </div>
  )
}

interface WebhookHistEntry { ts: string; mode: string; method: string; body: any; inputs: any }

function TriggerCard({ t, onToggle, onDelete }: { t: ForgeTrigger; onToggle: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false)
  const [history, setHistory] = useState<WebhookHistEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const copyUrl = (url: string) => {
    if (!url) return
    navigator.clipboard.writeText(url)
    setCopied(true); setTimeout(() => setCopied(false), 1200)
  }
  const loadHistory = async () => {
    const r = await api<{ ok: boolean; history: WebhookHistEntry[] }>(`/triggers/${t.id}/history`, undefined, true)
    setHistory(r?.history || [])
    setShowHistory(true)
  }
  const replay = async (idx: number) => {
    const r = await api<{ ok: boolean; run_id: number; status: string }>(`/triggers/${t.id}/replay/${idx}`, { method: 'POST' })
    if (r?.run_id) alert(`Run #${r.run_id} lancé (${r.status}). Voir l'onglet Historique.`)
  }
  const testUrl = t.webhook_url ? t.webhook_url.replace(/\/webhook\//, '/webhook/').replace(/\/?$/, '') + '/test' : ''
  return (
    <div style={{ padding: 10, marginBottom: 8, background: 'var(--bg-tertiary)', border: `1px solid ${t.enabled ? 'rgba(220,38,38,0.3)' : 'var(--border)'}`, borderRadius: 6, opacity: t.enabled ? 1 : 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {t.type === 'webhook' ? <LinkIcon size={11} style={{ color: 'var(--scarlet)' }} />
                              : t.type === 'cron' ? <Clock size={11} style={{ color: 'var(--scarlet)' }} />
                              : <Zap size={11} style={{ color: 'var(--text-muted)' }} />}
        <span style={{ fontSize: 'var(--font-xs)', fontWeight: 700, color: 'var(--scarlet)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{t.type}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onToggle}
          style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', background: t.enabled ? 'rgba(34,197,94,0.18)' : 'var(--bg-secondary)', color: t.enabled ? '#22c55e' : 'var(--text-muted)', border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}>
          {t.enabled ? 'Activé' : 'Désactivé'}
        </button>
        <button onClick={onDelete}
          style={{ fontSize: 'var(--font-xs)', padding: '0 4px', background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}>
          <X size={11} />
        </button>
      </div>
      {t.type === 'webhook' && t.webhook_url && (<>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: 4, background: 'var(--bg-primary)', borderRadius: 4, marginBottom: 4 }}>
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', flexShrink: 0 }}>PROD</span>
          <span style={{ flex: 1, fontSize: 'var(--font-2xs)', fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.webhook_url}</span>
          <button onClick={() => copyUrl(t.webhook_url || '')}
            title="Copier l'URL prod"
            style={{ padding: 3, background: 'transparent', border: 'none', cursor: 'pointer', color: copied ? '#22c55e' : 'var(--text-muted)' }}>
            <Copy size={11} />
          </button>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: 4, background: 'var(--bg-primary)', borderRadius: 4 }}>
          <span style={{ fontSize: 'var(--font-2xs)', color: '#f59e0b', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 2 }}><FlaskConical size={9} /> TEST</span>
          <span style={{ flex: 1, fontSize: 'var(--font-2xs)', fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{testUrl}</span>
          <button onClick={() => copyUrl(testUrl)}
            title="Copier l'URL test (ne lance pas le workflow)"
            style={{ padding: 3, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <Copy size={11} />
          </button>
        </div>
        <button onClick={() => showHistory ? setShowHistory(false) : loadHistory()}
          style={{ marginTop: 6, width: '100%', padding: '4px 8px', fontSize: 'var(--font-xs)', cursor: 'pointer', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)' }}>
          {showHistory ? 'Masquer historique' : 'Voir derniers POSTs reçus'}
        </button>
        {showHistory && (
          <div style={{ marginTop: 6, maxHeight: 200, overflow: 'auto' }}>
            {history.length === 0 && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', padding: 4, fontStyle: 'italic' }}>Aucun POST reçu encore.</div>}
            {history.map((h, idx) => (
              <div key={idx} style={{ padding: 4, marginBottom: 3, background: 'var(--bg-primary)', borderRadius: 3, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 'var(--font-2xs)', color: h.mode === 'test' ? '#f59e0b' : 'var(--scarlet)', fontWeight: 700, textTransform: 'uppercase' }}>{h.mode}</span>
                  <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>{h.method}</span>
                  <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', flex: 1 }}>{fmtDate(h.ts)}</span>
                  <button onClick={() => replay(idx)}
                    title="Rejouer"
                    style={{ padding: '1px 4px', fontSize: 'var(--font-2xs)', fontWeight: 600, background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 2, cursor: 'pointer' }}>
                    Rejouer
                  </button>
                </div>
                <pre style={{ margin: 0, marginTop: 3, fontSize: 'var(--font-2xs)', fontFamily: 'ui-monospace, monospace', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 60, overflow: 'auto' }}>
                  {JSON.stringify(h.body, null, 2).slice(0, 500)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </>)}
      {t.type === 'cron' && (
        <div style={{ fontSize: 'var(--font-xs)', fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)', padding: '3px 6px', background: 'var(--bg-primary)', borderRadius: 4, display: 'inline-block' }}>
          {t.config.expression || '?'}
        </div>
      )}
      {t.last_fire_at && (
        <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', marginTop: 4 }}>
          Dernier fire : {fmtDate(t.last_fire_at)}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Composant — Affichage d'un Run
// ═══════════════════════════════════════════════════════════════════════════════

function RunDisplay({ run }: { run: ForgeRun }) {
  const statusColor = run.status === 'success' ? '#10b981' : run.status === 'error' ? '#dc2626' : run.status === 'running' ? '#f59e0b' : '#737373'
  const StatusIcon = run.status === 'success' ? CheckCircle2 : run.status === 'error' ? AlertCircle : Clock
  // Groupe logs par step_id pour affichage compact.
  const grouped = useMemo(() => {
    const m = new Map<string, ForgeRunLog[]>()
    for (const l of run.logs) {
      const arr = m.get(l.step_id) || []
      arr.push(l)
      m.set(l.step_id, arr)
    }
    return Array.from(m.entries())
  }, [run.logs])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusIcon size={16} style={{ color: statusColor }} />
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 700, color: statusColor, textTransform: 'uppercase' }}>{run.status}</span>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>· {fmtDuration(run.duration_ms)}</span>
      </div>
      {run.error && (
        <div style={{ padding: 8, fontSize: 'var(--font-xs)', color: '#fca5a5', background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 4, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>
          {run.error}
        </div>
      )}
      <div>
        <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>STEPS</div>
        {grouped.map(([sid, evts]) => {
          const start = evts.find(e => e.type === 'start')
          const end = evts.find(e => e.type === 'end')
          const skip = evts.find(e => e.type === 'skip')
          const ok = end?.ok ?? false
          const color = skip ? '#737373' : ok ? '#10b981' : '#dc2626'
          return (
            <div key={sid} style={{ padding: '6px 8px', marginBottom: 4, background: 'var(--bg-tertiary)', borderRadius: 4, borderLeft: `3px solid ${color}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>{sid}</span>
                <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>{start?.tool || (skip ? 'skip' : '')}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>{fmtDuration(end?.duration_ms)}</span>
              </div>
              {skip && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginTop: 3, fontStyle: 'italic' }}>{skip.reason}</div>}
              {end?.error && <div style={{ fontSize: 'var(--font-xs)', color: '#fca5a5', marginTop: 3, fontFamily: 'ui-monospace, monospace' }}>{end.error}</div>}
            </div>
          )
        })}
      </div>
      {Object.keys(run.output || {}).length > 0 && (
        <div>
          <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>OUTPUT FINAL</div>
          <pre style={{ margin: 0, padding: 8, fontSize: 'var(--font-xs)', fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', borderRadius: 4, color: 'var(--text-secondary)', overflow: 'auto', maxHeight: 200 }}>
            {JSON.stringify(run.output, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB — Runs (historique)
// ═══════════════════════════════════════════════════════════════════════════════

function RunsTab() {
  const [runs, setRuns] = useState<ForgeRun[]>([])
  const [active, setActive] = useState<ForgeRun | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ ok: boolean; runs: ForgeRun[] }>('/runs?limit=100', undefined, true)
    setRuns(r?.runs || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <SecondaryButton size="sm" icon={<RefreshCw size={13} />} onClick={load}>Actualiser</SecondaryButton>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)' }}>Chargement…</div>
          : runs.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)' }}>Aucun run pour l'instant.</div>
          : runs.map(r => {
            const color = r.status === 'success' ? '#10b981' : r.status === 'error' ? '#dc2626' : '#f59e0b'
            return (
              <div key={r.id} onClick={() => setActive(r)}
                style={{
                  padding: '10px 14px', cursor: 'pointer',
                  borderBottom: '1px solid var(--border)',
                  background: active?.id === r.id ? 'rgba(220,38,38,0.12)' : 'transparent',
                  borderLeft: `3px solid ${color}`,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 700, color, textTransform: 'uppercase' }}>{r.status}</span>
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>· wf #{r.workflow_id}</span>
                  <ChevronRight size={11} style={{ marginLeft: 'auto', color: 'var(--text-muted)' }} />
                </div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginTop: 3 }}>{fmtDate(r.started_at)} · {r.trigger_source}</div>
              </div>
            )
          })}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
        {active ? <RunDisplay run={active} />
          : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>Sélectionnez un run pour voir le détail.</div>}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB — Templates (workflows pré-construits)
// ═══════════════════════════════════════════════════════════════════════════════

interface TemplateLite {
  id: string
  name: string
  category: string
  description: string
  tags: string[]
  trigger_hint?: string
}

function TemplatesTab() {
  const [tpls, setTpls] = useState<TemplateLite[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    (async () => {
      const r = await api<{ ok: boolean; templates: TemplateLite[] }>('/templates', undefined, true)
      setTpls(r?.templates || [])
      setLoading(false)
    })()
  }, [])
  const useTpl = async (id: string) => {
    if (!confirm("Créer un workflow basé sur ce template ?")) return
    const r = await api<{ ok: boolean; workflow_id: number; name: string }>(`/templates/${id}/use`, { method: 'POST' })
    if (r?.workflow_id) {
      alert(`Workflow "${r.name}" créé. Va dans l'onglet Workflows pour l'éditer.`)
    }
  }
  // Group by category
  const groups = useMemo(() => {
    const m = new Map<string, TemplateLite[]>()
    for (const t of tpls) {
      const arr = m.get(t.category) || []
      arr.push(t); m.set(t.category, arr)
    }
    return Array.from(m.entries())
  }, [tpls])
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 16px' }}>
      <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 14 }}>
        Démarre vite avec un template prêt à l'emploi. Crée une copie modifiable dans tes workflows.
      </div>
      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Chargement…</div>}
      {!loading && groups.map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid var(--border)' }}>
            <Sparkles size={13} style={{ color: 'var(--scarlet)' }} />
            <span style={{ fontSize: 'var(--font-xs)', fontWeight: 700, color: 'var(--scarlet)', letterSpacing: 0.5, textTransform: 'uppercase' }}>{cat}</span>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>· {items.length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
            {items.map(t => (
              <div key={t.id} style={{ padding: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{t.description}</div>
                {t.trigger_hint && (
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>💡 {t.trigger_hint}</div>
                )}
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {t.tags.map(tag => (
                    <span key={tag} style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', borderRadius: 3, background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>{tag}</span>
                  ))}
                </div>
                <div style={{ flex: 1 }} />
                <button onClick={() => useTpl(t.id)}
                  style={{ marginTop: 6, padding: '5px 10px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                  <Plus size={12} /> Utiliser
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB — Variables (globals user-scoped, CRUD direct)
// ═══════════════════════════════════════════════════════════════════════════════

interface ForgeGlobalVar {
  id: number
  key: string
  value: any
  updated_at: string | null
}

function VariablesTab() {
  const [vars, setVars] = useState<ForgeGlobalVar[]>([])
  const [loading, setLoading] = useState(true)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ ok: boolean; globals: ForgeGlobalVar[] }>('/globals', undefined, true)
    setVars(r?.globals || [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const upsert = async (key: string, valueRaw: string) => {
    if (!key.trim()) return
    let value: any = valueRaw
    // Auto-cast : essai JSON pour {}, [], booléens, nombres, sinon string brut.
    const t = valueRaw.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try { value = JSON.parse(t) } catch { value = valueRaw }
    } else if (t === 'true' || t === 'false') value = t === 'true'
    else if (t !== '' && !isNaN(Number(t))) value = Number(t)
    const r = await api(`/globals`, {
      method: 'POST',
      body: JSON.stringify({ key: key.trim(), value }),
    })
    if (r) load()
  }

  const remove = async (id: number) => {
    if (!confirm('Supprimer cette variable ?')) return
    await api(`/globals/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 16px' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
        Variables <strong>globales</strong> accessibles dans tous tes workflows via <code>{`{{ globals.X }}`}</code>.
        Pratique pour stocker des URLs d'API, IDs de canaux, secrets non-critiques.
        Pour les vraies credentials → Intégrations OAuth.
      </div>

      {/* Création rapide */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, padding: 10, background: 'var(--bg-secondary)', borderRadius: 6, border: '1px solid var(--border)' }}>
        <input value={newKey} onChange={e => setNewKey(e.target.value)}
          placeholder="clé (ex: api_url)"
          style={{ width: 180, padding: '5px 8px', fontSize: 'var(--font-xs)', fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }} />
        <input value={newValue} onChange={e => setNewValue(e.target.value)}
          placeholder='valeur (string, nombre, JSON...)'
          style={{ flex: 1, padding: '5px 8px', fontSize: 'var(--font-xs)', fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', outline: 'none' }} />
        <button onClick={() => { upsert(newKey, newValue); setNewKey(''); setNewValue('') }}
          style={{ padding: '5px 12px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 4 }}>
          Ajouter
        </button>
      </div>

      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Chargement…</div>}
      {!loading && vars.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>Aucune variable globale.</div>
      )}
      {!loading && vars.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-xs)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 'var(--font-xs)', fontWeight: 700, letterSpacing: 1 }}>CLÉ</th>
              <th style={{ padding: '6px 10px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 'var(--font-xs)', fontWeight: 700, letterSpacing: 1 }}>VALEUR</th>
              <th style={{ padding: '6px 10px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 'var(--font-xs)', fontWeight: 700, letterSpacing: 1 }}>MÀJ</th>
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {vars.map(v => (
              <tr key={v.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '7px 10px', fontFamily: 'ui-monospace, monospace', color: 'var(--scarlet)', fontWeight: 600 }}>
                  {`{{ globals.${v.key} }}`}
                </td>
                <td style={{ padding: '7px 10px', fontFamily: 'ui-monospace, monospace', color: 'var(--text-secondary)' }}>
                  <input
                    value={typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value ?? '')}
                    onBlur={e => upsert(v.key, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    style={{ width: '100%', padding: '3px 6px', fontSize: 'var(--font-xs)', fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-primary)', outline: 'none' }} />
                </td>
                <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>{fmtDate(v.updated_at)}</td>
                <td style={{ padding: '7px 10px' }}>
                  <button onClick={() => remove(v.id)}
                    style={{ padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                    <X size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB — Marketplace (templates communautaires)
// ═══════════════════════════════════════════════════════════════════════════════

interface MarketplaceItem {
  id: number
  author_id: number
  name: string
  description: string
  category: string
  tags: string[]
  downloads: number
  rating: number | null
  rating_count: number
  created_at: string | null
}

function MarketplaceTab() {
  const [items, setItems] = useState<MarketplaceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const qs = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''
    const r = await api<{ ok: boolean; templates: MarketplaceItem[] }>(`/marketplace${qs}`, undefined, true)
    setItems(r?.templates || [])
    setLoading(false)
  }, [search])
  useEffect(() => { load() }, [load])

  const install = async (it: MarketplaceItem) => {
    const r = await api<{ ok: boolean; workflow_id: number; name: string }>(`/marketplace/${it.id}/install`, { method: 'POST' })
    if (r?.workflow_id) alert(`"${r.name}" installé. Va dans Workflows pour l'éditer.`)
    load()
  }

  const rate = async (it: MarketplaceItem, rating: number) => {
    const r = await api(`/marketplace/${it.id}/rate`, { method: 'POST', body: JSON.stringify({ rating }) })
    if (r) load()
  }

  const groups = useMemo(() => {
    const m = new Map<string, MarketplaceItem[]>()
    for (const it of items) {
      const arr = m.get(it.category) || []
      arr.push(it); m.set(it.category, arr)
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [items])

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Rechercher un workflow communautaire…"
          style={{ flex: 1, padding: '7px 12px', fontSize: 'var(--font-sm)', borderRadius: 6, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }}
        />
        <button onClick={load}
          style={{ padding: '6px 10px', fontSize: 'var(--font-xs)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Workflows partagés par la communauté. Clique <strong>Installer</strong> pour cloner chez toi.
        Pour publier un de tes workflows : onglet Workflows → bouton "Publier" (à venir Phase 5).
      </div>
      {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Chargement…</div>}
      {!loading && items.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-sm)' }}>
          Aucun template communautaire disponible. Sois le premier à publier !
        </div>
      )}
      {!loading && groups.map(([cat, arr]) => (
        <div key={cat} style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, paddingBottom: 5, borderBottom: '1px solid var(--border)' }}>
            <Store size={13} style={{ color: 'var(--scarlet)' }} />
            <span style={{ fontSize: 'var(--font-xs)', fontWeight: 700, color: 'var(--scarlet)', letterSpacing: 0.5, textTransform: 'uppercase' }}>{cat}</span>
            <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>· {arr.length}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10 }}>
            {arr.map(it => (
              <div key={it.id} style={{ padding: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--text-primary)' }}>{it.name}</div>
                {it.description && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{it.description}</div>}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Download size={10} /> {it.downloads}</span>
                  {it.rating !== null && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#f59e0b' }}>
                      <Star size={10} fill="#f59e0b" /> {it.rating}/5 ({it.rating_count})
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {it.tags.map(t => (
                    <span key={t} style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', borderRadius: 3, background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>{t}</span>
                  ))}
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                  <button onClick={() => install(it)}
                    style={{ flex: 1, padding: '5px 10px', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', background: 'var(--scarlet)', color: '#fff', border: 'none', borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <Download size={12} /> Installer
                  </button>
                  <div style={{ display: 'flex', gap: 1 }}>
                    {[1, 2, 3, 4, 5].map(n => (
                      <button key={n} onClick={() => rate(it, n)}
                        title={`Noter ${n}/5`}
                        style={{ padding: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                        <Star size={12}
                          style={{
                            color: it.rating && n <= Math.round(it.rating) ? '#f59e0b' : 'var(--text-muted)',
                            fill: it.rating && n <= Math.round(it.rating) ? '#f59e0b' : 'none',
                          }} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB — Tools (catalogue)
// ═══════════════════════════════════════════════════════════════════════════════

function ToolsTab() {
  const [tools, setTools] = useState<ForgeTool[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    (async () => {
      setLoading(true)
      const r = await api<{ ok: boolean; tools: ForgeTool[] }>('/tools', undefined, true)
      setTools(r?.tools || [])
      setLoading(false)
    })()
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return tools
    return tools.filter(t => {
      const lbl = humanizeTool(t)
      return t.name.toLowerCase().includes(q)
          || t.description.toLowerCase().includes(q)
          || lbl.title.toLowerCase().includes(q)
          || lbl.category.toLowerCase().includes(q)
    })
  }, [tools, search])

  const groups = useMemo(() => groupByCategory(filtered), [filtered])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 24px 16px' }}>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder={`Rechercher dans ${tools.length} outils…`}
        style={{ padding: '7px 12px', fontSize: 'var(--font-sm)', borderRadius: 6, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', marginBottom: 10 }}
      />
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Chargement…</div>}
        {!loading && groups.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Aucun outil trouvé.</div>}
        {!loading && groups.map(group => {
          const Icon = group.icon
          return (
            <div key={group.category} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, paddingBottom: 5, borderBottom: `1px solid ${group.color}40` }}>
                <Icon size={14} style={{ color: group.color }} />
                <span style={{ fontSize: 'var(--font-xs)', fontWeight: 700, color: group.color, letterSpacing: 0.5, textTransform: 'uppercase' }}>{group.category}</span>
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>· {group.tools.length}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                {group.tools.map(t => {
                  const lbl = humanizeTool(t)
                  return (
                    <div key={t.name} style={{ padding: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>
                      <div style={{ fontSize: 'var(--font-sm)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>{lbl.title}</div>
                      <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', marginBottom: 6 }}>{t.name}</div>
                      {lbl.summary && (
                        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 6 }}>{lbl.summary}</div>
                      )}
                      {t.params.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {t.params.map(p => (
                            <span key={p.name} title={p.description} style={{ fontSize: 'var(--font-2xs)', padding: '1px 5px', borderRadius: 3, background: p.required ? 'rgba(220,38,38,0.18)' : 'var(--bg-tertiary)', color: p.required ? 'var(--scarlet)' : 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
                              {p.name}{p.required && '*'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
