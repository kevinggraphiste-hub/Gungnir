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
import { Workflow, Plus, Play, Trash2, RefreshCw, ChevronRight, Clock, Zap, AlertCircle, CheckCircle2, FileText } from 'lucide-react'
import { PageHeader, TabBar, PrimaryButton, SecondaryButton } from '@core/components/ui'
import InfoButton from '@core/components/InfoButton'
import { apiFetch } from '@core/services/api'

const PLUGIN_VERSION = '0.1.0'
const API = '/api/plugins/forge'

// ── Types ────────────────────────────────────────────────────────────────

interface ForgeWorkflow {
  id: number
  name: string
  description: string
  yaml_def: string
  enabled: boolean
  tags: string[]
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

const TABS = [
  { key: 'workflows' as const, label: 'Workflows', icon: <Workflow size={14} /> },
  { key: 'runs' as const, label: 'Historique', icon: <Clock size={14} /> },
  { key: 'tools' as const, label: 'Outils dispo', icon: <Zap size={14} /> },
]

// ── Helpers ──────────────────────────────────────────────────────────────

async function api<T = any>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await apiFetch(`${API}${path}`, init)
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      console.warn(`[Forge] ${path} → ${r.status}`, t)
      return null
    }
    return await r.json()
  } catch (e) {
    console.warn('[Forge] api error', e)
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
  const [tab, setTab] = useState<'workflows' | 'runs' | 'tools'>('workflows')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          icon={<Workflow size={18} />}
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
  const [draft, setDraft] = useState<{ name: string; description: string; yaml_def: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<ForgeRun | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await api<{ ok: boolean; workflows: ForgeWorkflow[] }>('/workflows')
    setList(r?.workflows || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Quand on sélectionne un workflow, on initialise le draft.
  useEffect(() => {
    if (active) {
      setDraft({ name: active.name, description: active.description, yaml_def: active.yaml_def })
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

  const handleRun = async () => {
    if (!active || !draft) return
    // Sauvegarde d'abord pour que le run tape la dernière version éditée.
    if (draft.yaml_def !== active.yaml_def
        || draft.name !== active.name
        || draft.description !== active.description) {
      await handleSave()
    }
    setRunning(true)
    setLastRun(null)
    const r = await api<{ ok: boolean; run: ForgeRun; detail?: string }>(
      `/workflows/${active.id}/run`,
      { method: 'POST', body: JSON.stringify({ inputs: {} }) },
    )
    setRunning(false)
    if (r?.run) setLastRun(r.run)
    else alert(`Exécution échouée${r?.detail ? ` : ${r.detail}` : ''}`)
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      {/* Liste workflows */}
      <div style={{
        width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 12px', display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
          <PrimaryButton size="sm" icon={<Plus size={13} />} onClick={handleCreate}>Nouveau</PrimaryButton>
          <SecondaryButton size="sm" icon={<RefreshCw size={13} />} onClick={load}>Actualiser</SecondaryButton>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Chargement…</div>
          : list.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
              Aucun workflow.<br />Cliquez sur <strong>Nouveau</strong> pour créer le premier.
            </div>
          : list.map(w => (
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
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
              </div>
              {w.description && <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.description}</div>}
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                {!w.enabled && <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>désactivé</span>}
                {w.tags.slice(0, 3).map(t => <span key={t} style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(220,38,38,0.18)', color: 'var(--scarlet)' }}>{t}</span>)}
              </div>
            </div>
          ))}
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
              style={{ flex: 1, minWidth: 200, padding: '5px 10px', fontSize: 13, fontWeight: 600, borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }}
            />
            <PrimaryButton size="sm" icon={<Play size={13} />} onClick={handleRun} disabled={running}>
              {running ? 'Exécution…' : 'Exécuter'}
            </PrimaryButton>
            <SecondaryButton size="sm" onClick={handleSave}>Sauvegarder</SecondaryButton>
            <SecondaryButton size="sm" danger icon={<Trash2 size={13} />} onClick={handleDelete}>Supprimer</SecondaryButton>
          </div>
          <input
            value={draft.description}
            onChange={e => setDraft({ ...draft, description: e.target.value })}
            placeholder="Description (optionnelle)"
            style={{ padding: '6px 16px', fontSize: 11, borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', border: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none', color: 'var(--text-muted)', outline: 'none' }}
          />

          {/* Split éditeur YAML / panel logs */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
              <div style={{ padding: '4px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
                YAML
              </div>
              <CodeMirror
                value={draft.yaml_def}
                theme={oneDark}
                extensions={[yamlLang()]}
                onChange={v => setDraft({ ...draft, yaml_def: v })}
                height="100%"
                style={{ flex: 1, overflow: 'auto', height: '100%' }}
                basicSetup={{
                  lineNumbers: true, foldGutter: true, highlightActiveLine: true,
                  bracketMatching: true, autocompletion: true, history: true,
                  indentOnInput: true, syntaxHighlighting: true, tabSize: 2,
                }}
              />
            </div>

            {/* Panel résultat run */}
            <div style={{ width: 380, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
              <div style={{ padding: '4px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, borderBottom: '1px solid var(--border)' }}>
                DERNIÈRE EXÉCUTION
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
                {running && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Exécution en cours…</div>}
                {!running && !lastRun && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>Cliquez <strong>Exécuter</strong> pour lancer ce workflow.</div>}
                {lastRun && <RunDisplay run={lastRun} />}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: 'var(--text-muted)', fontSize: 13 }}>
          <FileText size={40} style={{ opacity: 0.3 }} />
          <div>Sélectionnez un workflow ou créez-en un nouveau</div>
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
        <span style={{ fontSize: 12, fontWeight: 700, color: statusColor, textTransform: 'uppercase' }}>{run.status}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {fmtDuration(run.duration_ms)}</span>
      </div>
      {run.error && (
        <div style={{ padding: 8, fontSize: 11, color: '#fca5a5', background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(220,38,38,0.3)', borderRadius: 4, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>
          {run.error}
        </div>
      )}
      <div>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>STEPS</div>
        {grouped.map(([sid, evts]) => {
          const start = evts.find(e => e.type === 'start')
          const end = evts.find(e => e.type === 'end')
          const skip = evts.find(e => e.type === 'skip')
          const ok = end?.ok ?? false
          const color = skip ? '#737373' : ok ? '#10b981' : '#dc2626'
          return (
            <div key={sid} style={{ padding: '6px 8px', marginBottom: 4, background: 'var(--bg-tertiary)', borderRadius: 4, borderLeft: `3px solid ${color}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{sid}</span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{start?.tool || (skip ? 'skip' : '')}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{fmtDuration(end?.duration_ms)}</span>
              </div>
              {skip && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, fontStyle: 'italic' }}>{skip.reason}</div>}
              {end?.error && <div style={{ fontSize: 10, color: '#fca5a5', marginTop: 3, fontFamily: 'ui-monospace, monospace' }}>{end.error}</div>}
            </div>
          )
        })}
      </div>
      {Object.keys(run.output || {}).length > 0 && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 }}>OUTPUT FINAL</div>
          <pre style={{ margin: 0, padding: 8, fontSize: 10, fontFamily: 'ui-monospace, monospace', background: 'var(--bg-tertiary)', borderRadius: 4, color: 'var(--text-secondary)', overflow: 'auto', maxHeight: 200 }}>
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
    const r = await api<{ ok: boolean; runs: ForgeRun[] }>('/runs?limit=100')
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
          {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Chargement…</div>
          : runs.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Aucun run pour l'instant.</div>
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
                  <span style={{ fontSize: 9, fontWeight: 700, color, textTransform: 'uppercase' }}>{r.status}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· wf #{r.workflow_id}</span>
                  <ChevronRight size={11} style={{ marginLeft: 'auto', color: 'var(--text-muted)' }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>{fmtDate(r.started_at)} · {r.trigger_source}</div>
              </div>
            )
          })}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
        {active ? <RunDisplay run={active} />
          : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 12 }}>Sélectionnez un run pour voir le détail.</div>}
      </div>
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
      const r = await api<{ ok: boolean; tools: ForgeTool[] }>('/tools')
      setTools(r?.tools || [])
      setLoading(false)
    })()
  }, [])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return tools
    return tools.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
  }, [tools, search])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 24px 16px' }}>
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder={`Rechercher dans ${tools.length} outils…`}
        style={{ padding: '7px 12px', fontSize: 12, borderRadius: 6, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', marginBottom: 10 }}
      />
      <div style={{ flex: 1, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8, alignContent: 'start' }}>
        {loading ? <div style={{ gridColumn: '1 / -1', padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>Chargement…</div>
        : filtered.map(t => (
          <div key={t.name} style={{ padding: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--scarlet)', fontFamily: 'ui-monospace, monospace', marginBottom: 4 }}>{t.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 6 }}>{t.description}</div>
            {t.params.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                {t.params.map(p => (
                  <span key={p.name} title={p.description} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: p.required ? 'rgba(220,38,38,0.18)' : 'var(--bg-tertiary)', color: p.required ? 'var(--scarlet)' : 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>
                    {p.name}{p.required && '*'}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
