/**
 * Gungnir Plugin — Intégrations (Webhooks + Apps + MCP)
 *
 * Hub pour connecter des apps à l'agent : Gmail, Drive, GitHub, Slack, n8n, etc.
 * Chaque intégration démarre un serveur MCP → l'agent accède aux tools.
 * Plugin 100% indépendant.
 */
import { useState, useEffect, useCallback } from 'react'
import InfoButton from '@core/components/InfoButton'
import { PageHeader, TabBar, PrimaryButton, SecondaryButton } from '@core/components/ui'
import {
  Plug, Plus, Settings, Trash2, Play, Square,
  CheckCircle, Loader2, ChevronDown, ChevronRight,
  Webhook, ArrowUpRight, ArrowDownLeft, ExternalLink,
  Wrench, X, Search, Eye, EyeOff, Copy, Link2,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface CatalogEntry {
  display_name: string
  icon: string
  category: string
  description: string
  auth_type: string
  mcp_package: string | null
  required_env: string[]
  doc_url: string
  setup_guide: string
}

interface Integration {
  id: string
  enabled: boolean
  env_values: Record<string, string>
  display_name: string
  icon: string
  category: string
  description: string
  is_running: boolean
  tools_count: number
  tool_names: string[]
  has_mcp: boolean
  notes: string
}

interface WebhookEntry {
  id: string
  name: string
  direction: 'incoming' | 'outgoing'
  url?: string
  endpoint?: string
  secret?: string
  events: string[]
  enabled: boolean
  created_at: string
}

interface LogEntry {
  id: string
  webhook_name: string
  direction: string
  timestamp: string
  status: string
  error?: string
}

// ── Constants ──────────────────────────────────────────────────────────────

const API = '/api/plugins/webhooks'

const CATEGORY_LABELS: Record<string, string> = {
  communication: '💬 Communication',
  productivite: '📋 Productivité',
  dev: '🐙 Développement',
  stockage: '📁 Stockage',
  automation: '⚡ Automatisation',
  database: '🗄️ Base de données',
  search: '🔍 Recherche',
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function WebhooksPlugin() {
  const [activeTab, setActiveTab] = useState<'integrations' | 'connectors' | 'webhooks' | 'logs'>('integrations')
  const [catalog, setCatalog] = useState<Record<string, CatalogEntry>>({})
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [webhooks, setWebhooks] = useState<WebhookEntry[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [mcpStatus, setMcpStatus] = useState<any>(null)

  // Modals
  const [showCatalog, setShowCatalog] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [editingInteg, setEditingInteg] = useState<{ id: string; env_values: Record<string, string>; extra_args: string[]; notes: string } | null>(null)
  const [showNewWebhook, setShowNewWebhook] = useState(false)
  const [newWebhook, setNewWebhook] = useState({ name: '', direction: 'incoming' as 'incoming' | 'outgoing', url: '', events: '' })
  const [expandedTools, setExpandedTools] = useState<string | null>(null)

  // Saving / action state
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  // ── Custom MCP (serveurs hors catalog) ──────────────────────────────
  // Les MCPs du catalog vivent dans `integrations` (config JSON). Les MCPs
  // custom vivent UNIQUEMENT dans la table DB mcp_server_configs. Pour
  // éviter la duplication, on filtre ici tout ce qui matche un integration id.
  const [allDbMcps, setAllDbMcps] = useState<Array<{
    name: string
    command: string
    args: string[]
    env: Record<string, string>
    enabled: boolean
  }>>([])
  const [allDbMcpStatus, setAllDbMcpStatus] = useState<Array<{
    name: string; running: boolean; tools: number; tool_names: string[]
  }>>([])
  const [showCustomMcp, setShowCustomMcp] = useState(false)
  const [mcpAddForm, setMcpAddForm] = useState<{
    name: string; command: string; argsRaw: string
    envPairs: Array<{ key: string; value: string }>; enabled: boolean
  }>({
    name: '', command: 'npx', argsRaw: '',
    envPairs: [{ key: '', value: '' }], enabled: true,
  })
  const [mcpFlash, setMcpFlash] = useState<{ level: 'ok' | 'err'; msg: string } | null>(null)
  const MCP_ALLOWED_COMMANDS = [
    'npx', 'node', 'python', 'python3', 'pip', 'pipx', 'uvx',
    'docker', 'deno', 'bun', 'tsx', 'ts-node',
  ]

  // ── Data loading ───────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [catRes, integRes, whRes, mcpRes, dbMcpRes] = await Promise.all([
        fetch(`${API}/catalog`).then(r => r.json()),
        fetch(`${API}/integrations`).then(r => r.json()),
        fetch(`${API}/webhooks`).then(r => r.json()),
        fetch(`${API}/mcp/status`).then(r => r.json()),
        fetch('/api/config/mcp/servers').then(r => r.json()).catch(() => ({})),
      ])
      setCatalog(catRes.integrations || {})
      setIntegrations(integRes.integrations || [])
      setWebhooks(whRes.webhooks || [])
      setMcpStatus(mcpRes)
      setAllDbMcps(dbMcpRes.servers || [])
      setAllDbMcpStatus(dbMcpRes.status || [])
    } catch (err) { console.error('Load error:', err) }
    setLoading(false)
  }, [])

  // Filtrage : on affiche uniquement les MCPs DB qui ne correspondent PAS
  // à une intégration du catalog (par nom ou par mcp_server_name).
  const catalogMcpNames = new Set(
    integrations.map(i => i.id).concat(integrations.map(i => (i as any).mcp_server_name).filter(Boolean))
  )
  const customMcps = allDbMcps.filter(m => !catalogMcpNames.has(m.name))

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/logs?limit=50`)
      const data = await res.json()
      setLogs(data.logs || [])
    } catch {}
  }, [])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => { if (activeTab === 'logs') loadLogs() }, [activeTab, loadLogs])

  // ── Actions ────────────────────────────────────────────────────────

  // ── Custom MCP handlers ───────────────────────────────────────────
  const addCustomMcp = async () => {
    const f = mcpAddForm
    const name = f.name.trim()
    const command = f.command.trim()
    if (!name || !command) {
      setMcpFlash({ level: 'err', msg: 'Nom et commande requis' })
      return
    }
    const args = f.argsRaw.trim().split(/\s+/).filter(Boolean)
    const env: Record<string, string> = {}
    for (const { key, value } of f.envPairs) {
      const k = key.trim()
      if (k && value.trim()) env[k] = value.trim()
    }
    setActionLoading('mcp-custom-add')
    setMcpFlash(null)
    try {
      const resp = await fetch('/api/config/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, args, env, enabled: f.enabled }),
      })
      const data = await resp.json()
      if (!resp.ok || data.error) {
        setMcpFlash({ level: 'err', msg: data.error || `HTTP ${resp.status}` })
      } else if (data.ok) {
        const tools = data.tools_discovered ?? null
        setMcpFlash({
          level: 'ok',
          msg: tools !== null
            ? `Serveur '${name}' démarré — ${tools} outil(s) découvert(s)`
            : `Serveur '${name}' enregistré`,
        })
        setMcpAddForm({
          name: '', command: 'npx', argsRaw: '',
          envPairs: [{ key: '', value: '' }], enabled: true,
        })
        await loadAll()
      } else {
        setMcpFlash({ level: 'err', msg: data.error || 'Échec inconnu' })
      }
    } catch (err: any) {
      setMcpFlash({ level: 'err', msg: err?.message || 'Erreur réseau' })
    } finally {
      setActionLoading(null)
      setTimeout(() => setMcpFlash(null), 5000)
    }
  }

  const removeCustomMcp = async (name: string) => {
    if (!confirm(`Supprimer le serveur MCP '${name}' ? Le process sera arrêté.`)) return
    setActionLoading(`mcp-${name}`)
    try {
      await fetch(`/api/config/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await loadAll()
    } catch (err: any) {
      setMcpFlash({ level: 'err', msg: err?.message || 'Erreur' })
      setTimeout(() => setMcpFlash(null), 4000)
    } finally {
      setActionLoading(null)
    }
  }

  const toggleCustomMcp = async (srv: typeof allDbMcps[number]) => {
    setActionLoading(`mcp-${srv.name}`)
    try {
      const envForSend: Record<string, string> = {}
      for (const [k, v] of Object.entries(srv.env || {})) {
        if (v !== '***') envForSend[k] = v
      }
      await fetch('/api/config/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: srv.name, command: srv.command, args: srv.args,
          env: envForSend, enabled: !srv.enabled,
        }),
      })
      await loadAll()
    } catch (err: any) {
      setMcpFlash({ level: 'err', msg: err?.message || 'Erreur' })
      setTimeout(() => setMcpFlash(null), 4000)
    } finally {
      setActionLoading(null)
    }
  }

  const addIntegration = async (id: string) => {
    const entry = catalog[id]
    if (!entry) return
    setActionLoading(id)
    const env_values: Record<string, string> = {}
    for (const key of entry.required_env) env_values[key] = ''
    try {
      await fetch(`${API}/integrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled: true, env_values }),
      })
      setShowCatalog(false)
      await loadAll()
    } catch {}
    setActionLoading(null)
  }

  const removeIntegration = async (id: string) => {
    if (!confirm(`Supprimer l'intégration "${id}" ?`)) return
    setActionLoading(id)
    await fetch(`${API}/integrations/${id}`, { method: 'DELETE' })
    await loadAll()
    setActionLoading(null)
  }

  const startIntegration = async (id: string) => {
    setActionLoading(`start-${id}`)
    try {
      const res = await fetch(`${API}/integrations/${id}/start`, { method: 'POST' })
      const data = await res.json()
      if (!data.ok) alert(data.error || 'Erreur au démarrage')
      await loadAll()
    } catch {}
    setActionLoading(null)
  }

  const stopIntegration = async (id: string) => {
    setActionLoading(`stop-${id}`)
    await fetch(`${API}/integrations/${id}/stop`, { method: 'POST' })
    await loadAll()
    setActionLoading(null)
  }

  const saveIntegration = async () => {
    if (!editingInteg) return
    setActionLoading('save')
    await fetch(`${API}/integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingInteg),
    })
    setEditingInteg(null)
    await loadAll()
    setActionLoading(null)
  }

  const createWebhook = async () => {
    setActionLoading('webhook')
    await fetch(`${API}/webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newWebhook,
        events: newWebhook.events.split(',').map(e => e.trim()).filter(Boolean),
      }),
    })
    setShowNewWebhook(false)
    setNewWebhook({ name: '', direction: 'incoming', url: '', events: '' })
    await loadAll()
    setActionLoading(null)
  }

  const deleteWebhook = async (id: string) => {
    if (!confirm('Supprimer ce webhook ?')) return
    await fetch(`${API}/webhooks/${id}`, { method: 'DELETE' })
    await loadAll()
  }

  const openEdit = (integ: Integration) => {
    const cat = catalog[integ.id]
    const env: Record<string, string> = {}
    if (cat) {
      for (const key of cat.required_env) env[key] = integ.env_values[key] || ''
    }
    Object.entries(integ.env_values).forEach(([k, v]) => { if (!(k in env)) env[k] = v })
    setEditingInteg({ id: integ.id, env_values: env, extra_args: [], notes: integ.notes || '' })
  }

  // ── Render ─────────────────────────────────────────────────────────

  const activeIntegrations = integrations.filter(i => i.is_running)

  const tabs = [
    { key: 'integrations' as const, label: 'Apps & MCP', icon: <Plug size={14} /> },
    { key: 'connectors' as const, label: 'Connecteurs', icon: <Link2 size={14} /> },
    { key: 'webhooks' as const, label: 'Webhooks', icon: <Webhook size={14} /> },
    { key: 'logs' as const, label: 'Logs', icon: <Eye size={14} /> },
  ]

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="px-6 pt-6">
        <PageHeader
          icon={<Plug size={18} />}
          title="Intégrations"
          version="2.0.1"
          subtitle={(
            <span className="inline-flex items-center gap-1">
              {activeIntegrations.length} active{activeIntegrations.length > 1 ? 's' : ''} — {mcpStatus?.total_tools || 0} outils disponibles pour l'agent
              <InfoButton>
                <strong>Les intégrations</strong> sont des connecteurs vers des services externes (GitHub, n8n, Notion, Linear, Supabase, Sentry…) qui s'exposent à l'agent comme des <em>outils</em> appelables.
                <br /><br />
                Chaque intégration tourne comme un serveur MCP (Model Context Protocol) : une fois branchée, l'agent peut lire/écrire sur le service via des tool calls pendant une conversation ou un cron.
                <br /><br />
                Les <em>Webhooks</em> (onglet suivant) sont l'inverse : ils permettent à des services externes d'appeler ton agent quand un événement se produit (ex : un nouveau commit sur GitHub → l'agent est notifié et peut réagir).
                <br /><br />
                Tout est <em>per-user</em> : tes intégrations et leurs outils sont isolés des autres utilisateurs de l'instance.
              </InfoButton>
            </span>
          ) as any}
          actions={(
            <PrimaryButton size="sm" icon={<Plus size={14} />} onClick={() => setShowCatalog(true)}>
              Ajouter
            </PrimaryButton>
          )}
        />
      </div>

      <div className="px-6 pb-3">
        <TabBar tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} />
          </div>
        ) : (
          <>
            {/* ═══════ Integrations Tab ═══════ */}
            {activeTab === 'integrations' && (
              <div className="space-y-3">
                {integrations.length === 0 ? (
                  <div className="text-center py-12 px-6 rounded-xl border border-dashed space-y-3"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                    <Plug className="w-10 h-10 mx-auto opacity-40" style={{ color: 'var(--text-muted)' }} />
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Aucune intégration configurée</p>
                    <p className="text-xs max-w-md mx-auto leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Une intégration branche un service externe (GitHub, Notion, n8n, Linear, Supabase…) à ton agent sous forme d'<em>outils</em> qu'il pourra invoquer pendant une conversation ou un cron.
                    </p>
                    <div className="flex justify-center">
                      <PrimaryButton size="sm" icon={<Plus size={14} />} onClick={() => setShowCatalog(true)}>
                        Parcourir le catalogue
                      </PrimaryButton>
                    </div>
                  </div>
                ) : (
                  integrations.map(integ => {
                    const cat = catalog[integ.id]
                    return (
                      <div key={integ.id} className="border rounded-xl p-4 transition-colors"
                        style={{
                          background: 'var(--bg-secondary)',
                          borderColor: integ.is_running ? 'color-mix(in srgb, var(--accent-success) 40%, var(--border))' : 'var(--border)',
                        }}>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-2xl">{integ.icon}</span>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{integ.display_name}</span>
                                {integ.is_running ? (
                                  <span className="text-xs px-2 py-0.5 rounded-full flex items-center gap-1"
                                    style={{ background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)', color: 'var(--accent-success)' }}>
                                    <CheckCircle className="w-3 h-3" /> Actif — {integ.tools_count} outils
                                  </span>
                                ) : (
                                  <span className="text-xs px-2 py-0.5 rounded-full"
                                    style={{ background: 'color-mix(in srgb, var(--text-muted) 10%, transparent)', color: 'var(--text-muted)' }}>
                                    Inactif
                                  </span>
                                )}
                              </div>
                              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{integ.description}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {/* Start/Stop */}
                            {integ.has_mcp && !integ.is_running && (
                              <button onClick={() => startIntegration(integ.id)}
                                disabled={actionLoading === `start-${integ.id}`}
                                className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-primary)]" title="Démarrer">
                                {actionLoading === `start-${integ.id}` ? (
                                  <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--accent-success)' }} />
                                ) : (
                                  <Play className="w-4 h-4" style={{ color: 'var(--accent-success)' }} />
                                )}
                              </button>
                            )}
                            {integ.is_running && (
                              <button onClick={() => stopIntegration(integ.id)}
                                disabled={actionLoading === `stop-${integ.id}`}
                                className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-primary)]" title="Arrêter">
                                <Square className="w-4 h-4" style={{ color: 'var(--accent-error, #ef4444)' }} />
                              </button>
                            )}
                            {/* Configure */}
                            <button onClick={() => openEdit(integ)} className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-primary)]" title="Configurer">
                              <Settings className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                            </button>
                            {/* Doc link */}
                            {cat?.doc_url && (
                              <a href={cat.doc_url} target="_blank" rel="noopener" className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-primary)]" title="Documentation">
                                <ExternalLink className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                              </a>
                            )}
                            {/* Delete */}
                            <button onClick={() => removeIntegration(integ.id)} className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-primary)]" title="Supprimer">
                              <Trash2 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </div>
                        </div>

                        {/* Tools accordion */}
                        {integ.is_running && integ.tool_names.length > 0 && (
                          <div className="mt-3">
                            <button onClick={() => setExpandedTools(expandedTools === integ.id ? null : integ.id)}
                              className="flex items-center gap-1 text-xs transition-colors"
                              style={{ color: 'var(--text-muted)' }}>
                              {expandedTools === integ.id ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              <Wrench className="w-3 h-3" /> {integ.tools_count} outils disponibles
                            </button>
                            {expandedTools === integ.id && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {integ.tool_names.map(t => (
                                  <span key={t} className="text-xs px-2 py-1 rounded-md font-mono"
                                    style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}

                {/* ── Serveur MCP custom (hors catalog) ──────────── */}
                <div className="mt-6 border rounded-xl" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                  <button
                    onClick={() => setShowCustomMcp(v => !v)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-[var(--bg-primary)]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {showCustomMcp
                      ? <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      : <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
                    <Wrench className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
                    <span className="flex-1 text-left">Serveur MCP custom</span>
                    <span className="text-xs" style={{ color: customMcps.length > 0 ? 'var(--accent-success)' : 'var(--text-muted)' }}>
                      {customMcps.length > 0 ? `${customMcps.length} configuré${customMcps.length > 1 ? 's' : ''}` : 'avancé'}
                    </span>
                  </button>

                  {showCustomMcp && (
                    <div className="p-4 space-y-3 border-t" style={{ borderColor: 'var(--border)' }}>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        Ajoute un serveur MCP qui n'est pas dans le catalogue — un package custom (ex: <code>@yourorg/mcp-server-xyz</code>), un binaire Python local, un script Node privé. Tout ce qui peut être lancé avec l'une des commandes autorisées et qui parle JSON-RPC stdio.
                      </p>

                      {mcpFlash && (
                        <div className="text-xs p-2 rounded" style={{
                          background: mcpFlash.level === 'ok'
                            ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)'
                            : 'color-mix(in srgb, var(--accent-error) 15%, transparent)',
                          color: mcpFlash.level === 'ok' ? 'var(--accent-success)' : 'var(--accent-error)',
                        }}>
                          {mcpFlash.msg}
                        </div>
                      )}

                      {/* Liste des MCPs custom existants */}
                      {customMcps.length > 0 && (
                        <div className="space-y-2">
                          {customMcps.map(srv => {
                            const rt = allDbMcpStatus.find(s => s.name === srv.name)
                            const busy = actionLoading === `mcp-${srv.name}`
                            return (
                              <div key={srv.name} className="rounded-lg p-3" style={{
                                background: 'var(--bg-primary)',
                                border: srv.enabled ? '1px solid color-mix(in srgb, var(--accent-primary) 30%, var(--border))' : '1px solid var(--border)',
                              }}>
                                <div className="flex items-center gap-3 mb-2">
                                  <div className={`w-2 h-2 rounded-full ${rt?.running ? 'bg-green-400' : srv.enabled ? 'bg-yellow-400' : 'bg-gray-500'}`} />
                                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{srv.name}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                                    {srv.command} {srv.args.join(' ')}
                                  </span>
                                  {rt?.running && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                                      background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)',
                                      color: 'var(--accent-success)',
                                    }}>
                                      {rt.tools} outil{rt.tools > 1 ? 's' : ''}
                                    </span>
                                  )}
                                  <div className="flex items-center gap-1 ml-auto">
                                    <button onClick={() => toggleCustomMcp(srv)} disabled={busy}
                                      className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-secondary)]"
                                      title={srv.enabled ? 'Désactiver' : 'Activer'}>
                                      {busy
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                                        : srv.enabled
                                          ? <Square className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                                          : <Play className="w-3.5 h-3.5" style={{ color: 'var(--accent-success)' }} />}
                                    </button>
                                    <button onClick={() => removeCustomMcp(srv.name)} disabled={busy}
                                      className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-secondary)]" title="Supprimer">
                                      <Trash2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-error, #ef4444)' }} />
                                    </button>
                                  </div>
                                </div>
                                {Object.keys(srv.env || {}).length > 0 && (
                                  <div className="text-[11px] flex flex-wrap gap-1" style={{ color: 'var(--text-muted)' }}>
                                    {Object.entries(srv.env).map(([k, v]) => (
                                      <span key={k} style={{ background: 'var(--bg-secondary)', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace' }}>
                                        {k}={v}
                                      </span>
                                    ))}
                                  </div>
                                )}
                                {rt?.tool_names && rt.tool_names.length > 0 && (
                                  <div className="text-[11px] mt-2 flex flex-wrap gap-1">
                                    {rt.tool_names.slice(0, 8).map(tn => (
                                      <span key={tn} style={{
                                        background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                                        color: 'var(--accent-primary)',
                                        padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace',
                                      }}>
                                        {tn}
                                      </span>
                                    ))}
                                    {rt.tool_names.length > 8 && (
                                      <span style={{ color: 'var(--text-muted)' }}>+{rt.tool_names.length - 8}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Formulaire d'ajout */}
                      <div className="rounded-lg p-3 space-y-3" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Ajouter un serveur</h3>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Nom</label>
                            <input
                              value={mcpAddForm.name}
                              onChange={e => setMcpAddForm(f => ({ ...f, name: e.target.value }))}
                              placeholder="mon-mcp-custom"
                              className="w-full px-3 py-2 rounded-md text-sm outline-none"
                              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                            />
                          </div>
                          <div>
                            <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Commande <span style={{ color: 'var(--text-muted)' }}>(allowlist)</span></label>
                            <select
                              value={mcpAddForm.command}
                              onChange={e => setMcpAddForm(f => ({ ...f, command: e.target.value }))}
                              className="w-full px-3 py-2 rounded-md text-sm outline-none"
                              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                            >
                              {MCP_ALLOWED_COMMANDS.map(cmd => <option key={cmd} value={cmd}>{cmd}</option>)}
                            </select>
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Arguments (espace-séparés)</label>
                          <input
                            value={mcpAddForm.argsRaw}
                            onChange={e => setMcpAddForm(f => ({ ...f, argsRaw: e.target.value }))}
                            placeholder="-y @yourorg/mcp-server-xyz"
                            className="w-full px-3 py-2 rounded-md text-sm font-mono outline-none"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                          />
                        </div>

                        <div>
                          <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>Variables d'environnement</label>
                          <div className="space-y-2">
                            {mcpAddForm.envPairs.map((pair, idx) => (
                              <div key={idx} className="flex gap-2">
                                <input
                                  value={pair.key}
                                  onChange={e => {
                                    const next = [...mcpAddForm.envPairs]
                                    next[idx] = { ...pair, key: e.target.value }
                                    setMcpAddForm(f => ({ ...f, envPairs: next }))
                                  }}
                                  placeholder="API_KEY"
                                  className="flex-1 px-2 py-1.5 rounded-md text-sm font-mono outline-none"
                                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                />
                                <input
                                  type={/key|secret|token|password/i.test(pair.key) ? 'password' : 'text'}
                                  value={pair.value}
                                  onChange={e => {
                                    const next = [...mcpAddForm.envPairs]
                                    next[idx] = { ...pair, value: e.target.value }
                                    setMcpAddForm(f => ({ ...f, envPairs: next }))
                                  }}
                                  placeholder="valeur"
                                  className="flex-1 px-2 py-1.5 rounded-md text-sm font-mono outline-none"
                                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                                />
                                <button
                                  onClick={() => {
                                    const next = mcpAddForm.envPairs.filter((_, i) => i !== idx)
                                    setMcpAddForm(f => ({ ...f, envPairs: next.length ? next : [{ key: '', value: '' }] }))
                                  }}
                                  className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-secondary)]" title="Retirer">
                                  <X className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                                </button>
                              </div>
                            ))}
                            <button
                              onClick={() => setMcpAddForm(f => ({ ...f, envPairs: [...f.envPairs, { key: '', value: '' }] }))}
                              className="text-xs flex items-center gap-1" style={{ color: 'var(--accent-primary)' }}>
                              <Plus className="w-3.5 h-3.5" /> Ajouter une variable
                            </button>
                          </div>
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={mcpAddForm.enabled}
                            onChange={e => setMcpAddForm(f => ({ ...f, enabled: e.target.checked }))}
                            className="w-4 h-4 accent-[var(--accent-primary)]" />
                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            Démarrer immédiatement après l'ajout
                          </span>
                        </label>

                        <div className="flex justify-end">
                          <PrimaryButton size="sm" onClick={addCustomMcp}
                            disabled={actionLoading === 'mcp-custom-add' || !mcpAddForm.name.trim()}>
                            {actionLoading === 'mcp-custom-add' ? 'Ajout…' : 'Ajouter le serveur'}
                          </PrimaryButton>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ═══════ Connecteurs OAuth Tab ═══════ */}
            {activeTab === 'connectors' && <ConnectorsTab />}

            {/* ═══════ Webhooks Tab ═══════ */}
            {activeTab === 'webhooks' && (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <PrimaryButton size="sm" icon={<Plus size={12} />} onClick={() => setShowNewWebhook(true)}>
                    Nouveau webhook
                  </PrimaryButton>
                </div>

                {webhooks.length === 0 ? (
                  <div className="text-center py-10 px-6 rounded-xl border border-dashed space-y-2"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Aucun webhook configuré</p>
                    <p className="text-xs max-w-md mx-auto leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Un webhook sortant laisse ton agent notifier un service externe quand quelque chose se passe (ex : envoyer un résumé quotidien sur Slack, déclencher un workflow n8n, pousser un rapport sur Discord…). Clique sur <strong>Nouveau webhook</strong> pour en créer un.
                    </p>
                  </div>
                ) : (
                  webhooks.map(wh => (
                    <div key={wh.id} className="border rounded-lg p-4 flex items-center justify-between"
                      style={{ background: 'var(--bg-secondary)', borderColor: wh.enabled ? 'var(--border)' : 'color-mix(in srgb, var(--text-muted) 20%, var(--border))' }}>
                      <div className="flex items-center gap-3">
                        {wh.direction === 'incoming' ? (
                          <ArrowDownLeft className="w-5 h-5" style={{ color: 'var(--accent-success)' }} />
                        ) : (
                          <ArrowUpRight className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
                        )}
                        <div>
                          <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{wh.name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-xs px-1.5 py-0.5 rounded"
                              style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                              {wh.direction === 'incoming' ? 'Entrant' : 'Sortant'}
                            </span>
                            {wh.endpoint && (
                              <button onClick={() => navigator.clipboard.writeText(window.location.origin + wh.endpoint)}
                                className="flex items-center gap-1 text-xs hover:underline" style={{ color: 'var(--accent-primary)' }}>
                                <Copy className="w-3 h-3" /> Copier l'URL
                              </button>
                            )}
                            {wh.url && <span className="text-xs truncate max-w-[200px]" style={{ color: 'var(--text-muted)' }}>{wh.url}</span>}
                          </div>
                        </div>
                      </div>
                      <button onClick={() => deleteWebhook(wh.id)} className="p-2 rounded-lg hover:bg-[var(--bg-primary)]">
                        <Trash2 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* ═══════ Logs Tab ═══════ */}
            {activeTab === 'logs' && (
              <div className="space-y-2">
                {logs.length === 0 ? (
                  <p className="text-center py-12 text-sm" style={{ color: 'var(--text-muted)' }}>Aucun log</p>
                ) : (
                  logs.map(log => (
                    <div key={log.id} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
                      style={{ background: 'var(--bg-secondary)' }}>
                      {log.direction === 'incoming' ? (
                        <ArrowDownLeft className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-success)' }} />
                      ) : (
                        <ArrowUpRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                      )}
                      <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{log.webhook_name}</span>
                      <span className={`px-1.5 py-0.5 rounded ${log.status === 'error' ? '' : ''}`}
                        style={{
                          background: log.status === 'error' ? 'color-mix(in srgb, var(--accent-error) 15%, transparent)' : 'color-mix(in srgb, var(--accent-success) 15%, transparent)',
                          color: log.status === 'error' ? 'var(--accent-error)' : 'var(--accent-success)',
                        }}>
                        {log.status}
                      </span>
                      <span className="ml-auto" style={{ color: 'var(--text-muted)' }}>
                        {new Date(log.timestamp).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ═══════ Catalog Modal ═══════ */}
      {showCatalog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowCatalog(false)}>
          <div className="w-full max-w-2xl max-h-[80vh] overflow-hidden rounded-xl border flex flex-col"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }} onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
              <h3 className="font-bold" style={{ color: 'var(--text-primary)' }}>Catalogue d'intégrations</h3>
              <button onClick={() => setShowCatalog(false)}><X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} /></button>
            </div>

            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input type="text" value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)}
                  placeholder="Rechercher une intégration..."
                  className="w-full pl-10 pr-4 py-2 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] text-sm focus:outline-none"
                  style={{ color: 'var(--text-primary)' }} />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {Object.entries(CATEGORY_LABELS).map(([catKey, catLabel]) => {
                const items = Object.entries(catalog).filter(([, v]) =>
                  v.category === catKey &&
                  (v.display_name.toLowerCase().includes(catalogSearch.toLowerCase()) || !catalogSearch)
                )
                if (items.length === 0) return null
                const alreadyAdded = new Set(integrations.map(i => i.id))
                return (
                  <div key={catKey}>
                    <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{catLabel}</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {items.map(([key, entry]) => (
                        <button key={key} disabled={alreadyAdded.has(key) || actionLoading === key}
                          onClick={() => addIntegration(key)}
                          className="flex items-center gap-3 p-3 rounded-lg border text-left transition-colors hover:border-[var(--accent-primary)] disabled:opacity-50"
                          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                          <span className="text-xl">{entry.icon}</span>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium block" style={{ color: 'var(--text-primary)' }}>{entry.display_name}</span>
                            <span className="text-xs truncate block" style={{ color: 'var(--text-muted)' }}>{entry.description}</span>
                          </div>
                          {alreadyAdded.has(key) ? (
                            <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-success)' }} />
                          ) : actionLoading === key ? (
                            <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                          ) : (
                            <Plus className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ═══════ Edit Integration Modal ═══════ */}
      {editingInteg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingInteg(null)}>
          <div className="w-full max-w-lg rounded-xl border p-6 space-y-4"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold" style={{ color: 'var(--text-primary)' }}>
                {catalog[editingInteg.id]?.icon} {catalog[editingInteg.id]?.display_name || editingInteg.id}
              </h3>
              <button onClick={() => setEditingInteg(null)}><X className="w-5 h-5" style={{ color: 'var(--text-muted)' }} /></button>
            </div>

            {catalog[editingInteg.id]?.setup_guide && (
              <div className="text-xs p-3 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)', color: 'var(--text-secondary)' }}>
                💡 {catalog[editingInteg.id].setup_guide}
              </div>
            )}

            <div className="space-y-3">
              {Object.entries(editingInteg.env_values).map(([key, val]) => {
                const isSecret = ['key', 'secret', 'token', 'password'].some(s => key.toLowerCase().includes(s))
                return (
                  <div key={key}>
                    <label className="text-xs font-mono mb-1 block" style={{ color: 'var(--text-muted)' }}>{key}</label>
                    <div className="relative">
                      <input
                        type={isSecret && !showSecrets[key] ? 'password' : 'text'}
                        value={val}
                        placeholder={val === '***' ? '••• (configuré)' : `Valeur pour ${key}`}
                        onChange={e => setEditingInteg(prev => prev ? { ...prev, env_values: { ...prev.env_values, [key]: e.target.value } } : null)}
                        className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 pr-10 text-sm font-mono focus:outline-none"
                        style={{ color: 'var(--text-primary)' }} />
                      {isSecret && (
                        <button onClick={() => setShowSecrets(p => ({ ...p, [key]: !p[key] }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2">
                          {showSecrets[key] ? <EyeOff className="w-4 h-4" style={{ color: 'var(--text-muted)' }} /> : <Eye className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div>
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Notes (optionnel)</label>
              <input type="text" value={editingInteg.notes} placeholder="Notes personnelles..."
                onChange={e => setEditingInteg(prev => prev ? { ...prev, notes: e.target.value } : null)}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ color: 'var(--text-primary)' }} />
            </div>

            <div className="flex gap-2 pt-2">
              <PrimaryButton size="sm" className="flex-1 justify-center" onClick={saveIntegration} disabled={actionLoading === 'save'}>
                {actionLoading === 'save' ? 'Sauvegarde...' : 'Sauvegarder & Fermer'}
              </PrimaryButton>
              <SecondaryButton size="sm" onClick={() => setEditingInteg(null)}>
                Annuler
              </SecondaryButton>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ New Webhook Modal ═══════ */}
      {showNewWebhook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowNewWebhook(false)}>
          <div className="w-full max-w-md rounded-xl border p-6 space-y-4"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }} onClick={e => e.stopPropagation()}>
            <h3 className="font-bold" style={{ color: 'var(--text-primary)' }}>Nouveau webhook</h3>

            <div>
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Nom</label>
              <input type="text" value={newWebhook.name} placeholder="Mon webhook"
                onChange={e => setNewWebhook(p => ({ ...p, name: e.target.value }))}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ color: 'var(--text-primary)' }} />
            </div>

            <div>
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>Direction</label>
              <select value={newWebhook.direction}
                onChange={e => setNewWebhook(p => ({ ...p, direction: e.target.value as 'incoming' | 'outgoing' }))}
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ color: 'var(--text-primary)' }}>
                <option value="incoming">Entrant — reçoit des données</option>
                <option value="outgoing">Sortant — envoie des données</option>
              </select>
            </div>

            {newWebhook.direction === 'outgoing' && (
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>URL cible</label>
                <input type="text" value={newWebhook.url} placeholder="https://..."
                  onChange={e => setNewWebhook(p => ({ ...p, url: e.target.value }))}
                  className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ color: 'var(--text-primary)' }} />
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <PrimaryButton size="sm" className="flex-1 justify-center" icon={<Plus size={12} />}
                onClick={createWebhook} disabled={!newWebhook.name || actionLoading === 'webhook'}>
                Créer
              </PrimaryButton>
              <SecondaryButton size="sm" onClick={() => setShowNewWebhook(false)}>
                Annuler
              </SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// ── ConnectorsTab : connecteurs OAuth + BYOT (GitHub, Google, Notion) ──────
function ConnectorsTab() {
  const [providers, setProviders] = useState<any[]>([])
  const [connections, setConnections] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  // Provider currently in « manual token » input mode (clicked « Saisir un token »)
  const [manualMode, setManualMode] = useState<string | null>(null)
  const [manualToken, setManualToken] = useState('')
  const [manualError, setManualError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [p, c] = await Promise.all([
        fetch(`${API}/oauth/providers`).then(r => r.json()).catch(() => ({ providers: [] })),
        fetch(`${API}/oauth/connections`).then(r => r.json()).catch(() => ({ connections: [] })),
      ])
      setProviders(p.providers || [])
      const map: Record<string, any> = {}
      ;(c.connections || []).forEach((conn: any) => { map[conn.provider] = conn })
      setConnections(map)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'gungnir-oauth') {
        if (e.data.success) load()
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [load])

  const connect = async (provider: string) => {
    setBusy(provider)
    try {
      const r = await fetch(`${API}/oauth/${provider}/authorize`).then(r => r.json())
      if (r.error || !r.authorize_url) {
        alert(r.error || 'Erreur lors de la génération du lien OAuth')
        return
      }
      window.open(r.authorize_url, 'gungnir-oauth', 'width=520,height=720')
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (provider: string) => {
    if (!confirm(`Déconnecter ${provider} ?`)) return
    setBusy(provider)
    try {
      await fetch(`${API}/oauth/${provider}/disconnect`, { method: 'POST' })
      await load()
    } finally {
      setBusy(null)
    }
  }

  const submitManualToken = async (provider: string) => {
    if (!manualToken.trim()) {
      setManualError('Token vide')
      return
    }
    setManualError('')
    setBusy(provider)
    try {
      const r = await fetch(`${API}/oauth/${provider}/manual_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: manualToken.trim() }),
      }).then(r => r.json())
      if (!r.ok) {
        setManualError(r.error || 'Échec de la validation')
        return
      }
      setManualMode(null)
      setManualToken('')
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Chargement…</div>

  return (
    <div className="space-y-3">
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Connecte des services tiers une fois — Gungnir appellera leurs API depuis le chat.
        Deux modes possibles : <strong>OAuth</strong> (popup d'autorisation propre) ou
        <strong> token manuel</strong> (PAT / Integration Token, idéal en self-hosting).
      </div>
      {providers.map(p => {
        const conn = connections[p.provider] || {}
        const isConnected = conn.connected
        const isInManualMode = manualMode === p.provider
        return (
          <div key={p.provider}
            className="rounded-lg p-4"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Plug size={14} />
                  <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{p.display_name}</span>
                  {!p.configured && !p.manual_token_supported && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'color-mix(in srgb, var(--accent-warning, #f59e0b) 12%, transparent)',
                               color: 'var(--accent-warning, #f59e0b)' }}>
                      config OAuth serveur requise
                    </span>
                  )}
                  {!p.configured && p.manual_token_supported && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'color-mix(in srgb, var(--accent-tertiary) 12%, transparent)',
                               color: 'var(--accent-tertiary)' }}>
                      OAuth indispo — utilise un token
                    </span>
                  )}
                  {isConnected && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1"
                      style={{ background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)',
                               color: 'var(--accent-success)' }}>
                      <CheckCircle size={10} /> Connecté ({conn.mode === 'manual' ? 'token' : 'OAuth'})
                    </span>
                  )}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{p.description}</div>
                {isConnected && conn.account_label && (
                  <div className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Compte : <code>{conn.account_label}</code>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <SecondaryButton size="sm" onClick={() => disconnect(p.provider)} disabled={busy === p.provider}>
                    Déconnecter
                  </SecondaryButton>
                ) : (
                  <>
                    {p.configured && (
                      <PrimaryButton size="sm"
                        onClick={() => connect(p.provider)}
                        disabled={busy === p.provider}>
                        Connecter (OAuth)
                      </PrimaryButton>
                    )}
                    {p.manual_token_supported && (
                      <SecondaryButton size="sm"
                        onClick={() => { setManualMode(isInManualMode ? null : p.provider); setManualToken(''); setManualError('') }}>
                        {isInManualMode ? 'Annuler' : 'Saisir un token'}
                      </SecondaryButton>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Saisie manuelle du token */}
            {isInManualMode && !isConnected && (
              <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>
                  <strong>{p.manual_token_label}</strong>
                  {p.manual_token_url && (
                    <>
                      {' — '}
                      <a href={p.manual_token_url} target="_blank" rel="noopener noreferrer"
                        style={{ color: 'var(--accent-primary)' }}>
                        créer le token <ExternalLink size={10} className="inline" />
                      </a>
                    </>
                  )}
                </div>
                {p.manual_token_help && (
                  <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    {p.manual_token_help}
                  </div>
                )}
                <div className="flex gap-2">
                  <input type="password" value={manualToken}
                    onChange={e => { setManualToken(e.target.value); setManualError('') }}
                    placeholder="Colle ton token ici"
                    className="flex-1 rounded-lg px-3 py-2 text-xs font-mono"
                    style={{
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                    }} />
                  <PrimaryButton size="sm"
                    onClick={() => submitManualToken(p.provider)}
                    disabled={busy === p.provider || !manualToken.trim()}>
                    Enregistrer
                  </PrimaryButton>
                </div>
                {manualError && (
                  <div className="text-[11px] mt-2" style={{ color: 'var(--accent-danger, #ef4444)' }}>
                    {manualError}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
