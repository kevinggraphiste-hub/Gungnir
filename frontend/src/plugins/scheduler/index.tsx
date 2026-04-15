/**
 * Gungnir Plugin — Automata v1.0.0
 *
 * Two tabs:
 * 1. Taches — scheduled tasks created by the LLM via chat
 * 2. Workflows — n8n workflow management
 *
 * Self-contained — no core dependency beyond CSS variables.
 */
import { useState, useEffect, useCallback } from 'react'
import InfoButton from '@core/components/InfoButton'

// ── Types ────────────────────────────────────────────────────────────────────

interface Task {
  id: string
  name: string
  description: string
  prompt: string
  task_type: 'cron' | 'interval' | 'once'
  cron_expression?: string
  interval_seconds?: number
  run_at?: string
  enabled: boolean
  created_at: string
  updated_at: string
  last_run: string | null
  run_count: number
  last_status: string | null
  last_result: string | null
}

interface Stats { total: number; active: number; paused: number; total_runs: number }

interface N8nWorkflow {
  id: string
  name: string
  active: boolean
  created_at: string
  updated_at: string
  tags: string[]
  node_count: number
}

interface N8nExecution {
  id: string
  workflow_id: string
  workflow_name: string
  status: string
  started_at: string
  finished_at: string
  mode: string
}

// ── API ──────────────────────────────────────────────────────────────────────

const API = '/api/plugins/scheduler'

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    // Forward the auth token so the backend resolves the right user.
    // Without this, /tasks falls back to user_id=0 and no per-user data
    // (including tasks created by the LLM) shows up in the UI.
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts?.headers as Record<string, string> || {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${API}${path}`, { ...opts, headers })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

function fmtInterval(s: number | undefined): string {
  if (!s) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}j`
}

function fmtSchedule(t: Task): string {
  if (t.task_type === 'cron' && t.cron_expression) return `Cron: ${t.cron_expression}`
  if (t.task_type === 'interval') return `Toutes les ${fmtInterval(t.interval_seconds)}`
  if (t.task_type === 'once') return `Le ${fmtDate(t.run_at || null)}`
  return '—'
}

// ── Config ───────────────────────────────────────────────────────────────────

const TYPE_CFG: Record<string, { label: string; color: string; icon: string }> = {
  cron: { label: 'Recurrent', color: '#6366f1', icon: '🔄' },
  interval: { label: 'Intervalle', color: '#3b82f6', icon: '⏱️' },
  once: { label: 'Unique', color: '#22c55e', icon: '📌' },
}

const STATUS_COLORS: Record<string, string> = {
  success: '#22c55e', manual: '#3b82f6', error: '#dc2626', triggered: '#f59e0b',
}

const N8N_STATUS: Record<string, { label: string; color: string }> = {
  success: { label: 'Succes', color: '#22c55e' },
  error: { label: 'Erreur', color: '#dc2626' },
  running: { label: 'En cours', color: '#f59e0b' },
  waiting: { label: 'Attente', color: '#6366f1' },
  crashed: { label: 'Crash', color: '#dc2626' },
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function AutomataPlugin() {
  const [tab, setTab] = useState<'tasks' | 'n8n'>('tasks')

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header with tabs */}
      <div style={{
        padding: '14px 24px 0', background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>Automata</span>
            <InfoButton>
              <strong>Les automatas</strong> sont des tâches que l'agent exécute tout seul à des moments précis — une fois à une date donnée, toutes les N minutes/heures, ou selon une expression cron.
              <br /><br />
              À chaque déclenchement, l'agent lit ton prompt et y répond comme si tu venais de l'écrire dans le chat. Il a accès aux mêmes outils que pendant une conversation normale (recherche web, MCP, filesystem, etc.), donc il peut par exemple faire une veille matinale qui pousse un résumé sur Discord, ou un backup quotidien.
              <br /><br />
              Le <em>heartbeat</em> est le chef d'orchestre : c'est lui qui scanne tes automatas à intervalle régulier et les déclenche. Si tu arrêtes le heartbeat dans Paramètres, tes automatas ne tournent plus.
            </InfoButton>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 0 }}>
          <TabBtn active={tab === 'tasks'} onClick={() => setTab('tasks')}>Taches planifiees</TabBtn>
          <TabBtn active={tab === 'n8n'} onClick={() => setTab('n8n')}>Workflows n8n</TabBtn>
        </div>
      </div>

      {tab === 'tasks' ? <TasksTab /> : <N8nTab />}
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '8px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
      background: 'transparent', border: 'none',
      borderBottom: active ? '2px solid var(--scarlet)' : '2px solid transparent',
      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
      transition: 'all 0.15s',
    }}>
      {children}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 — Scheduled Tasks
// ═══════════════════════════════════════════════════════════════════════════════

function TasksTab() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, paused: 0, total_runs: 0 })
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const d = await apiFetch<{ tasks: Task[]; stats: Stats }>('/tasks')
    if (d) { setTasks(d.tasks); setStats(d.stats) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = async (id: string) => { await apiFetch(`/tasks/${id}/toggle`, { method: 'POST' }); load() }
  const del = async (id: string) => { await apiFetch(`/tasks/${id}`, { method: 'DELETE' }); setExpandedId(null); load() }
  const run = async (id: string) => { await apiFetch(`/tasks/${id}/run`, { method: 'POST' }); load() }
  const save = async (id: string, u: any) => { await apiFetch(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(u) }); setEditingId(null); load() }
  const create = async (body: any) => {
    const res = await apiFetch('/tasks', { method: 'POST', body: JSON.stringify(body) })
    if (res) { setCreating(false); load() }
  }

  const filtered = tasks.filter(t => filter === 'all' || (filter === 'active' ? t.enabled : !t.enabled))

  if (loading) return <Loading />

  return (
    <>
      {/* Stats bar */}
      <div style={{
        padding: '10px 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', display: 'flex', gap: 20, alignItems: 'center', flexShrink: 0,
      }}>
        <Badge label="Total" value={stats.total} color="var(--text-secondary)" />
        <Badge label="Actives" value={stats.active} color="#22c55e" />
        <Badge label="En pause" value={stats.paused} color="#f59e0b" />
        <Badge label="Executions" value={stats.total_runs} color="var(--text-secondary)" />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          {(['all', 'active', 'paused'] as const).map(f => (
            <FilterBtn key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Toutes' : f === 'active' ? 'Actives' : 'En pause'}
            </FilterBtn>
          ))}
          <button onClick={() => setCreating(true)} style={{
            background: 'var(--scarlet)', border: 'none', borderRadius: 6,
            padding: '5px 12px', color: '#fff', cursor: 'pointer', marginLeft: 8,
            fontSize: 11, fontWeight: 700,
          }} title="Créer une nouvelle tâche">+ Nouvelle</button>
          <button onClick={load} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
            padding: '3px 8px', color: 'var(--text-muted)', cursor: 'pointer',
          }} title="Rafraichir">↻</button>
        </div>
      </div>

      {creating && <CreateTaskModal onCreate={create} onCancel={() => setCreating(false)} />}

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 40px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>⚙️</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>
              {filter !== 'all' ? 'Aucune tache ne correspond au filtre' : 'Aucune automatisation'}
            </div>
            {filter === 'all' && (
              <div style={{ fontSize: 12, lineHeight: 1.6, maxWidth: 400, margin: '0 auto' }}>
                Demandez au chat de creer des taches planifiees.<br />
                <i style={{ color: 'var(--text-muted)' }}>Ex: "Verifie mes backups tous les jours a 9h"</i>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(t => (
              <TaskCard key={t.id} task={t}
                expanded={expandedId === t.id} editing={editingId === t.id}
                onToggle={() => toggle(t.id)} onDelete={() => del(t.id)}
                onRunNow={() => run(t.id)}
                onExpand={() => setExpandedId(expandedId === t.id ? null : t.id)}
                onEdit={() => setEditingId(editingId === t.id ? null : t.id)}
                onSaveEdit={(u) => save(t.id, u)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 — n8n Workflows
// ═══════════════════════════════════════════════════════════════════════════════

// ── Core API helper (for MCP endpoints which are on /api, not /api/plugins/scheduler) ──
const CORE_API = '/api'

async function coreApiFetch<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts?.headers as Record<string, string> || {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${CORE_API}${path}`, { ...opts, headers })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

function N8nTab() {
  const [configured, setConfigured] = useState(false)
  const [n8nUrl, setN8nUrl] = useState('')
  const [n8nKey, setN8nKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [workflows, setWorkflows] = useState<N8nWorkflow[]>([])
  const [executions, setExecutions] = useState<N8nExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [configMode, setConfigMode] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)

  // MCP state
  const [mcpCommand, setMcpCommand] = useState('npx')
  const [mcpArgs, setMcpArgs] = useState('-y @n8n/n8n-mcp-server')
  const [mcpConnected, setMcpConnected] = useState(false)
  const [mcpToolCount, setMcpToolCount] = useState(0)
  const [mcpSaving, setMcpSaving] = useState(false)
  const [mcpResult, setMcpResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)

  const loadConfig = useCallback(async () => {
    const cfg = await apiFetch<{ url: string; has_key: boolean; configured: boolean }>('/n8n/config')
    if (cfg) {
      setN8nUrl(cfg.url)
      setHasKey(cfg.has_key)
      setConfigured(cfg.configured)
      if (!cfg.configured) setConfigMode(true)
    }
    // Load MCP status
    const mcp = await coreApiFetch<{ servers: any[]; status: any[] }>('/mcp/servers')
    if (mcp) {
      const n8nServer = mcp.status?.find((s: any) => s.name === 'n8n')
      if (n8nServer) {
        setMcpConnected(n8nServer.running)
        setMcpToolCount(n8nServer.tools || 0)
      }
    }
  }, [])

  const loadWorkflows = useCallback(async () => {
    setLoading(true)
    const [wf, ex] = await Promise.all([
      apiFetch<{ workflows: N8nWorkflow[] }>('/n8n/workflows'),
      apiFetch<{ executions: N8nExecution[] }>('/n8n/executions'),
    ])
    if (wf) setWorkflows(wf.workflows)
    if (ex) setExecutions(ex.executions)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadConfig().then(() => {})
  }, [loadConfig])

  useEffect(() => {
    if (configured && !configMode) loadWorkflows()
  }, [configured, configMode, loadWorkflows])

  const handleSaveConfig = async () => {
    setSaving(true)
    await apiFetch('/n8n/config', { method: 'PUT', body: JSON.stringify({ url: n8nUrl, api_key: n8nKey }) })
    const test = await apiFetch<{ ok: boolean; message?: string; error?: string }>('/n8n/test')
    setTestResult(test)
    if (test?.ok) {
      setConfigured(true)
      setHasKey(true)
      setConfigMode(false)
      loadWorkflows()
    }
    setSaving(false)
  }

  const handleSaveMcp = async () => {
    setMcpSaving(true)
    setMcpResult(null)
    // Build env from n8n URL + API key
    const n8nEnv: Record<string, string> = {}
    if (n8nUrl) n8nEnv['N8N_BASE_URL'] = n8nUrl
    if (n8nKey) n8nEnv['N8N_API_KEY'] = n8nKey
    // If key was already saved and user didn't re-enter, we still send the env
    // The backend will use whatever is in the config

    const res = await coreApiFetch<{ ok: boolean; tools_discovered?: number; error?: string }>('/mcp/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'n8n',
        command: mcpCommand,
        args: mcpArgs.split(/\s+/).filter(Boolean),
        env: n8nEnv,
        enabled: true,
      }),
    })

    if (res?.ok) {
      setMcpConnected(true)
      setMcpToolCount(res.tools_discovered || 0)
      setMcpResult({ ok: true, message: `MCP connecte — ${res.tools_discovered || 0} outils decouverts` })
    } else {
      setMcpResult({ ok: false, error: res?.error || 'Echec de connexion MCP' })
    }
    setMcpSaving(false)
  }

  const handleToggleWorkflow = async (id: string, currentlyActive: boolean) => {
    const endpoint = currentlyActive ? 'deactivate' : 'activate'
    await apiFetch(`/n8n/workflows/${id}/${endpoint}`, { method: 'POST' })
    loadWorkflows()
  }

  const handleExecuteWorkflow = async (id: string) => {
    await apiFetch(`/n8n/workflows/${id}/execute`, { method: 'POST' })
    setTimeout(loadWorkflows, 1500) // refresh after a delay for execution to register
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    color: 'var(--text-primary)', fontSize: 12, outline: 'none',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', marginBottom: 4, display: 'block',
  }

  // Config screen
  if (configMode) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
        <div style={{
          maxWidth: 500, margin: '40px auto', background: 'var(--bg-card)',
          border: '1px solid var(--border)', borderRadius: 12, padding: '24px',
        }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4 }}>
            Connexion n8n
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
            Connectez votre instance n8n pour gerer vos workflows depuis Gungnir.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>URL de l'instance n8n</label>
              <input value={n8nUrl} onChange={e => setN8nUrl(e.target.value)}
                placeholder="http://localhost:5678" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Cle API</label>
              <input value={n8nKey} onChange={e => setN8nKey(e.target.value)}
                placeholder={hasKey ? '••••••••  (deja configuree, laisser vide pour garder)' : 'n8n_api_...'}
                type="password" style={inputStyle} />
            </div>

            {testResult && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: testResult.ok ? 'rgba(34,197,94,.1)' : 'rgba(220,38,38,.1)',
                color: testResult.ok ? '#22c55e' : '#dc2626',
                border: `1px solid ${testResult.ok ? '#22c55e33' : '#dc262633'}`,
              }}>
                {testResult.ok ? '✓ ' + testResult.message : '✗ ' + testResult.error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              {configured && (
                <button onClick={() => setConfigMode(false)} style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                }}>Annuler</button>
              )}
              <button onClick={handleSaveConfig} disabled={saving || !n8nUrl} style={{
                padding: '8px 20px', borderRadius: 8, border: 'none',
                background: n8nUrl ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                color: n8nUrl ? '#fff' : 'var(--text-muted)',
                cursor: n8nUrl ? 'pointer' : 'not-allowed',
                fontSize: 12, fontWeight: 600,
              }}>
                {saving ? 'Test en cours...' : 'Connecter'}
              </button>
            </div>
          </div>
        </div>

        {/* MCP Server Config */}
        <div style={{
          maxWidth: 500, margin: '20px auto', background: 'var(--bg-card)',
          border: '1px solid var(--border)', borderRadius: 12, padding: '24px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>
              Serveur MCP n8n
            </div>
            <InfoButton>
              <strong>MCP</strong> (Model Context Protocol) est un standard qui permet à un LLM d'appeler des services externes comme s'il s'agissait d'outils natifs. Un serveur MCP expose une liste d'actions (API n8n, API Notion, etc.) que l'agent peut invoquer.
              <br /><br />
              Concrètement, une fois le MCP n8n connecté, ton agent peut <em>lire, créer, modifier ou exécuter</em> tes workflows n8n directement depuis une conversation ou un cron.
              <br /><br />
              Les serveurs MCP sont isolés <em>per-user</em> : tes clés API passent en variables d'environnement et restent privées.
            </InfoButton>
            {mcpConnected && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                background: 'rgba(34,197,94,.1)', color: '#22c55e',
              }}>{mcpToolCount} outils</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
            Connectez le MCP n8n pour permettre a l'IA de modifier vos workflows directement.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={labelStyle}>Commande</label>
              <input value={mcpCommand} onChange={e => setMcpCommand(e.target.value)}
                placeholder="npx" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Arguments</label>
              <input value={mcpArgs} onChange={e => setMcpArgs(e.target.value)}
                placeholder="-y @n8n/n8n-mcp-server" style={inputStyle} />
            </div>

            <div style={{
              padding: '8px 12px', borderRadius: 8, fontSize: 11,
              background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
              lineHeight: 1.5,
            }}>
              L'URL et la cle API n8n (ci-dessus) seront automatiquement transmises au serveur MCP
              via les variables d'environnement N8N_BASE_URL et N8N_API_KEY.
            </div>

            {mcpResult && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12,
                background: mcpResult.ok ? 'rgba(34,197,94,.1)' : 'rgba(220,38,38,.1)',
                color: mcpResult.ok ? '#22c55e' : '#dc2626',
                border: `1px solid ${mcpResult.ok ? '#22c55e33' : '#dc262633'}`,
              }}>
                {mcpResult.ok ? '✓ ' + mcpResult.message : '✗ ' + mcpResult.error}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={handleSaveMcp} disabled={mcpSaving || !mcpCommand} style={{
                padding: '8px 20px', borderRadius: 8, border: 'none',
                background: mcpCommand ? '#6366f1' : 'var(--bg-tertiary)',
                color: mcpCommand ? '#fff' : 'var(--text-muted)',
                cursor: mcpCommand ? 'pointer' : 'not-allowed',
                fontSize: 12, fontWeight: 600,
              }}>
                {mcpSaving ? 'Connexion...' : mcpConnected ? 'Reconnecter MCP' : 'Connecter MCP'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <Loading />

  const activeWf = workflows.filter(w => w.active).length

  return (
    <>
      {/* Stats */}
      <div style={{
        padding: '10px 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', display: 'flex', gap: 20, alignItems: 'center', flexShrink: 0,
      }}>
        <Badge label="Workflows" value={workflows.length} color="var(--text-secondary)" />
        <Badge label="Actifs" value={activeWf} color="#22c55e" />
        <Badge label="Inactifs" value={workflows.length - activeWf} color="#f59e0b" />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={loadWorkflows} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
            padding: '3px 8px', color: 'var(--text-muted)', cursor: 'pointer',
          }} title="Rafraichir">↻</button>
          <button onClick={() => setConfigMode(true)} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
            padding: '3px 8px', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11,
          }} title="Configuration n8n">⚙️</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>
        {workflows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 40px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.3 }}>🔗</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: 'var(--text-secondary)' }}>
              Aucun workflow n8n
            </div>
            <div style={{ fontSize: 12 }}>
              Creez des workflows dans votre instance n8n, ils apparaitront ici.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Workflows */}
            {workflows.map(w => (
              <WorkflowCard key={w.id} workflow={w}
                onToggle={() => handleToggleWorkflow(w.id, w.active)}
                onExecute={() => handleExecuteWorkflow(w.id)}
                onRefresh={loadWorkflows}
              />
            ))}

            {/* Recent executions */}
            {executions.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                  textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
                }}>
                  Executions recentes
                </div>
                <div style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 10, overflow: 'hidden',
                }}>
                  {executions.map((ex, i) => {
                    const st = N8N_STATUS[ex.status] || { label: ex.status, color: '#6b7280' }
                    return (
                      <div key={ex.id || i} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 16px',
                        borderBottom: i < executions.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                        fontSize: 12,
                      }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: st.color, flexShrink: 0,
                        }} />
                        <span style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 600 }}>
                          {ex.workflow_name || ex.workflow_id}
                        </span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                          background: `${st.color}20`, color: st.color,
                        }}>{st.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {fmtDate(ex.started_at)}
                        </span>
                        <span style={{
                          fontSize: 9, padding: '2px 6px', borderRadius: 4,
                          background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                        }}>{ex.mode}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ── Workflow Card ─────────────────────────────────────────────────────────────

function WorkflowCard({ workflow: w, onToggle, onExecute, onRefresh }: {
  workflow: N8nWorkflow; onToggle: () => void; onExecute: () => void; onRefresh: () => void
}) {
  const [hover, setHover] = useState(false)
  const [showModify, setShowModify] = useState(false)
  const [modifyPrompt, setModifyPrompt] = useState('')
  const [modifying, setModifying] = useState(false)
  const [modifyResult, setModifyResult] = useState<{ ok: boolean; response?: string; error?: string } | null>(null)

  const handleModify = async () => {
    if (!modifyPrompt.trim() || modifying) return
    setModifying(true)
    setModifyResult(null)
    const res = await apiFetch<{ ok: boolean; response?: string; error?: string; tool_results?: any[] }>(
      `/n8n/workflows/${w.id}/modify`,
      { method: 'POST', body: JSON.stringify({ prompt: modifyPrompt }) }
    )
    setModifyResult(res)
    setModifying(false)
    if (res?.ok) {
      setModifyPrompt('')
      onRefresh()
    }
  }

  return (
    <div
      style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden',
        opacity: w.active ? 1 : 0.55, transition: 'all 0.15s',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onToggle} style={{
            width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
            background: w.active ? '#22c55e' : 'var(--bg-tertiary)',
            position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 2, left: w.active ? 16 : 2, transition: 'left 0.2s',
            }} />
          </button>

          <span style={{ fontSize: 16 }}>🔗</span>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{w.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
              {w.node_count} noeud{w.node_count > 1 ? 's' : ''} — Modifie {fmtDate(w.updated_at)}
            </div>
          </div>

          {w.tags.length > 0 && (
            <div style={{ display: 'flex', gap: 3 }}>
              {w.tags.map(tag => (
                <span key={tag} style={{
                  fontSize: 9, padding: '2px 6px', borderRadius: 4,
                  background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                }}>{tag}</span>
              ))}
            </div>
          )}

          <div style={{ opacity: hover ? 1 : 0, transition: 'opacity 0.15s', display: 'flex', gap: 4 }}>
            <SmallBtn title="Modifier via IA" onClick={() => setShowModify(!showModify)}>✨</SmallBtn>
            <SmallBtn title="Executer" onClick={onExecute}>▶</SmallBtn>
          </div>
        </div>
      </div>

      {/* Inline modify panel */}
      {showModify && (
        <div style={{
          padding: '0 18px 14px', borderTop: '1px solid var(--border-subtle)',
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', margin: '10px 0 6px', textTransform: 'uppercase' }}>
            Modifier via IA + MCP
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={modifyPrompt}
              onChange={e => setModifyPrompt(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleModify()}
              placeholder="Ex: ajoute un node Discord apres le trigger..."
              disabled={modifying}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 8,
                background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
                color: 'var(--text-primary)', fontSize: 12, outline: 'none',
              }}
            />
            <button
              onClick={handleModify}
              disabled={modifying || !modifyPrompt.trim()}
              style={{
                padding: '8px 16px', borderRadius: 8, border: 'none',
                background: modifyPrompt.trim() ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                color: modifyPrompt.trim() ? '#fff' : 'var(--text-muted)',
                cursor: modifyPrompt.trim() ? 'pointer' : 'not-allowed',
                fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              }}
            >
              {modifying ? 'En cours...' : 'Envoyer'}
            </button>
          </div>

          {modifyResult && (
            <div style={{
              marginTop: 8, padding: '8px 12px', borderRadius: 8, fontSize: 12,
              background: modifyResult.ok ? 'rgba(34,197,94,.08)' : 'rgba(220,38,38,.08)',
              border: `1px solid ${modifyResult.ok ? '#22c55e33' : '#dc262633'}`,
              color: modifyResult.ok ? 'var(--text-primary)' : '#dc2626',
              lineHeight: 1.5, whiteSpace: 'pre-wrap',
            }}>
              {modifyResult.ok ? modifyResult.response : modifyResult.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Task Card ────────────────────────────────────────────────────────────────

function TaskCard({ task, expanded, editing, onToggle, onDelete, onRunNow, onExpand, onEdit, onSaveEdit }: {
  task: Task; expanded: boolean; editing: boolean
  onToggle: () => void; onDelete: () => void; onRunNow: () => void
  onExpand: () => void; onEdit: () => void; onSaveEdit: (u: any) => void
}) {
  const [hover, setHover] = useState(false)
  const tc = TYPE_CFG[task.task_type] || { label: task.task_type, color: '#6b7280', icon: '📋' }
  const sc = STATUS_COLORS[task.last_status || ''] || 'var(--text-muted)'

  return (
    <div
      style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 10, overflow: 'hidden',
        opacity: task.enabled ? 1 : 0.55, transition: 'all 0.15s',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <button onClick={onToggle} style={{
            width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
            background: task.enabled ? '#22c55e' : 'var(--bg-tertiary)',
            position: 'relative', transition: 'background 0.2s', flexShrink: 0,
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: '50%', background: '#fff',
              position: 'absolute', top: 2, left: task.enabled ? 16 : 2, transition: 'left 0.2s',
            }} />
          </button>
          <span style={{ fontSize: 16 }}>{tc.icon}</span>
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={onExpand}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{task.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{task.description}</div>
          </div>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
            background: `${tc.color}20`, color: tc.color, flexShrink: 0,
          }}>{tc.label}</span>
          <div style={{ display: 'flex', gap: 4, opacity: hover ? 1 : 0, transition: 'opacity 0.15s' }}>
            <SmallBtn title="Executer" onClick={onRunNow}>▶</SmallBtn>
            <SmallBtn title="Modifier" onClick={onEdit}>✏️</SmallBtn>
            <SmallBtn title="Supprimer" onClick={onDelete} danger>🗑</SmallBtn>
          </div>
        </div>
        <div style={{
          display: 'flex', gap: 20, alignItems: 'center', paddingLeft: 58,
          fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap',
        }}>
          <span>🕐 {fmtSchedule(task)}</span>
          <span>↻ {task.run_count} execution{task.run_count !== 1 ? 's' : ''}</span>
          {task.last_run && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: sc, display: 'inline-block' }} />
              Derniere : {fmtDate(task.last_run)}
            </span>
          )}
        </div>
      </div>

      {expanded && !editing && (
        <div style={{ padding: '12px 18px 14px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
            Prompt execute par le LLM
          </div>
          <div style={{
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
            background: 'var(--bg-tertiary)', padding: '10px 14px', borderRadius: 8,
            fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'pre-wrap',
            maxHeight: 200, overflow: 'auto',
          }}>
            {task.prompt || '(aucun prompt)'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
            Cree le {fmtDate(task.created_at)} — Modifie le {fmtDate(task.updated_at)}
          </div>
        </div>
      )}

      {editing && <EditPanel task={task} onSave={onSaveEdit} onCancel={onEdit} />}
    </div>
  )
}

// ── Edit Panel ───────────────────────────────────────────────────────────────

function EditPanel({ task, onSave, onCancel }: { task: Task; onSave: (u: any) => void; onCancel: () => void }) {
  const [name, setName] = useState(task.name)
  const [desc, setDesc] = useState(task.description)
  const [prompt, setPrompt] = useState(task.prompt)
  const [cron, setCron] = useState(task.cron_expression || '')
  const [interval, setInterval_] = useState(task.interval_seconds || 3600)

  const save = () => {
    const u: any = { name, description: desc, prompt }
    if (task.task_type === 'cron') u.cron_expression = cron
    if (task.task_type === 'interval') u.interval_seconds = interval
    onSave(u)
  }

  const iStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    color: 'var(--text-primary)', fontSize: 12, outline: 'none',
  }
  const lStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4, display: 'block',
  }

  return (
    <div style={{ padding: '14px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}><label style={lStyle}>Nom</label><input value={name} onChange={e => setName(e.target.value)} style={iStyle} /></div>
        <div style={{ flex: 2 }}><label style={lStyle}>Description</label><input value={desc} onChange={e => setDesc(e.target.value)} style={iStyle} /></div>
      </div>
      {task.task_type === 'cron' && (
        <div><label style={lStyle}>Expression cron</label><input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * 1-5" style={iStyle} /></div>
      )}
      {task.task_type === 'interval' && (
        <div><label style={lStyle}>Intervalle (secondes) — {fmtInterval(interval)}</label><input type="number" value={interval} min={10} onChange={e => setInterval_(parseInt(e.target.value) || 0)} style={iStyle} /></div>
      )}
      <div><label style={lStyle}>Prompt envoye au LLM</label><textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} style={{ ...iStyle, resize: 'vertical', fontFamily: "'JetBrains Mono', monospace" }} /></div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Annuler</button>
        <button onClick={save} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--scarlet)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Enregistrer</button>
      </div>
    </div>
  )
}

function CreateTaskModal({ onCreate, onCancel }: { onCreate: (body: any) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [prompt, setPrompt] = useState('')
  const [taskType, setTaskType] = useState<'cron' | 'interval' | 'run_at'>('interval')
  const [cron, setCron] = useState('0 9 * * *')
  const [interval, setInterval_] = useState(3600)
  const [runAt, setRunAt] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (!name.trim()) { setError('Nom requis'); return }
    if (!prompt.trim()) { setError('Prompt requis'); return }
    const body: any = { name: name.trim(), description: desc, prompt, task_type: taskType, enabled }
    if (taskType === 'cron') body.cron_expression = cron
    if (taskType === 'interval') body.interval_seconds = interval
    if (taskType === 'run_at') body.run_at = runAt
    setError(null)
    onCreate(body)
  }

  const iStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px', borderRadius: 8,
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    color: 'var(--text-primary)', fontSize: 12, outline: 'none',
  }
  const lStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4, display: 'block',
  }

  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '92%', maxWidth: 560, maxHeight: '88vh', overflow: 'auto',
        background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 24, display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Nouvelle tâche planifiée</div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}><label style={lStyle}>Nom</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Résumé du matin" style={iStyle} /></div>
          <div style={{ flex: 2 }}><label style={lStyle}>Description</label>
            <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optionnel" style={iStyle} /></div>
        </div>

        <div>
          <label style={lStyle}>Type de planification</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['interval', 'cron', 'run_at'] as const).map(t => (
              <button key={t} onClick={() => setTaskType(t)} style={{
                flex: 1, padding: '6px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                border: '1px solid var(--border)', cursor: 'pointer',
                background: taskType === t ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                color: taskType === t ? '#fff' : 'var(--text-muted)',
              }}>
                {t === 'interval' ? 'Intervalle' : t === 'cron' ? 'Cron' : 'Date unique'}
              </button>
            ))}
          </div>
        </div>

        {taskType === 'cron' && (
          <div>
            <label style={lStyle}>Expression cron</label>
            <input value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * 1-5" style={{ ...iStyle, fontFamily: "'JetBrains Mono', monospace" }} />
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              Format : minute heure jour mois jour-semaine. Ex: <code>0 9 * * 1-5</code> = 9h du lundi au vendredi
            </div>
          </div>
        )}
        {taskType === 'interval' && (
          <div>
            <label style={lStyle}>Intervalle en secondes — {fmtInterval(interval)}</label>
            <input type="number" min={10} value={interval} onChange={e => setInterval_(parseInt(e.target.value) || 0)} style={iStyle} />
          </div>
        )}
        {taskType === 'run_at' && (
          <div>
            <label style={lStyle}>Date & heure (ISO 8601)</label>
            <input type="datetime-local" value={runAt} onChange={e => setRunAt(e.target.value)} style={iStyle} />
          </div>
        )}

        <div>
          <label style={lStyle}>Prompt envoyé au LLM</label>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4}
            placeholder="Ex: Fais-moi un résumé rapide de l'actualité tech du jour en 3 bullet points."
            style={{ ...iStyle, resize: 'vertical', fontFamily: "'JetBrains Mono', monospace" }} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          Activer immédiatement
        </label>

        {error && <div style={{ fontSize: 11, color: '#dc2626' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={onCancel} style={{
            padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 600,
          }}>Annuler</button>
          <button onClick={submit} style={{
            padding: '7px 16px', borderRadius: 8, border: 'none',
            background: 'var(--scarlet)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 700,
          }}>Créer</button>
        </div>
      </div>
    </div>
  )
}

// ── Shared components ────────────────────────────────────────────────────────

function Badge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 800, color }}>{value}</span>
    </div>
  )
}

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
      border: 'none', cursor: 'pointer',
      background: active ? 'var(--scarlet)' : 'var(--bg-tertiary)',
      color: active ? '#fff' : 'var(--text-muted)', transition: 'all 0.15s',
    }}>{children}</button>
  )
}

function SmallBtn({ children, title, onClick, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; danger?: boolean
}) {
  return (
    <button onClick={onClick} title={title} style={{
      background: 'var(--bg-tertiary)', border: 'none', borderRadius: 6,
      width: 26, height: 26, cursor: 'pointer', fontSize: 11,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: danger ? '#dc2626' : 'var(--text-secondary)', transition: 'background 0.15s',
    }}>{children}</button>
  )
}

function Loading() {
  return (
    <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-muted)' }}>
      Chargement...
    </div>
  )
}
