/**
 * Gungnir Plugin — Intégrations (Webhooks + Apps + MCP)
 *
 * Hub pour connecter des apps à l'agent : Gmail, Drive, GitHub, Slack, n8n, etc.
 * Chaque intégration démarre un serveur MCP → l'agent accède aux tools.
 * Plugin 100% indépendant.
 */
import { useState, useEffect, useCallback } from 'react'
import InfoButton from '@core/components/InfoButton'
import {
  Plug, Plus, Settings, Trash2, Play, Square, RefreshCw,
  CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronRight,
  Webhook, ArrowUpRight, ArrowDownLeft, ExternalLink,
  Wrench, X, Search, Eye, EyeOff, Copy,
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
  const [activeTab, setActiveTab] = useState<'integrations' | 'webhooks' | 'logs'>('integrations')
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

  // ── Data loading ───────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [catRes, integRes, whRes, mcpRes] = await Promise.all([
        fetch(`${API}/catalog`).then(r => r.json()),
        fetch(`${API}/integrations`).then(r => r.json()),
        fetch(`${API}/webhooks`).then(r => r.json()),
        fetch(`${API}/mcp/status`).then(r => r.json()),
      ])
      setCatalog(catRes.integrations || {})
      setIntegrations(integRes.integrations || [])
      setWebhooks(whRes.webhooks || [])
      setMcpStatus(mcpRes)
    } catch (err) { console.error('Load error:', err) }
    setLoading(false)
  }, [])

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

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-6 pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 20%, transparent), color-mix(in srgb, var(--accent-secondary) 15%, transparent))' }}>
            <Plug className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Intégrations</h1>
              <InfoButton>
                <strong>Les intégrations</strong> sont des connecteurs vers des services externes (GitHub, n8n, Notion, Linear, Supabase, Sentry…) qui s'exposent à l'agent comme des <em>outils</em> appelables.
                <br /><br />
                Chaque intégration tourne comme un serveur MCP (Model Context Protocol) : une fois branchée, l'agent peut lire/écrire sur le service via des tool calls pendant une conversation ou un cron.
                <br /><br />
                Les <em>Webhooks</em> (onglet suivant) sont l'inverse : ils permettent à des services externes d'appeler ton agent quand un événement se produit (ex : un nouveau commit sur GitHub → l'agent est notifié et peut réagir).
                <br /><br />
                Tout est <em>per-user</em> : tes intégrations et leurs outils sont isolés des autres utilisateurs de l'instance.
              </InfoButton>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {activeIntegrations.length} active{activeIntegrations.length > 1 ? 's' : ''} — {mcpStatus?.total_tools || 0} outils disponibles pour l'agent
            </p>
          </div>
        </div>
        <button onClick={() => setShowCatalog(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: 'var(--accent-primary)', color: '#fff' }}>
          <Plus className="w-4 h-4" /> Ajouter
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 mb-3">
        {([
          { id: 'integrations', label: 'Apps & MCP', icon: Plug },
          { id: 'webhooks', label: 'Webhooks', icon: Webhook },
          { id: 'logs', label: 'Logs', icon: Eye },
        ] as const).map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors"
            style={{
              background: activeTab === tab.id ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'transparent',
              color: activeTab === tab.id ? 'var(--accent-primary)' : 'var(--text-muted)',
              border: `1px solid ${activeTab === tab.id ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'transparent'}`,
            }}>
            <tab.icon className="w-3.5 h-3.5" /> {tab.label}
          </button>
        ))}
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
                    <button onClick={() => setShowCatalog(true)}
                      className="px-4 py-2 rounded-lg text-sm font-medium"
                      style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                      <Plus className="w-4 h-4 inline mr-1" /> Parcourir le catalogue
                    </button>
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
              </div>
            )}

            {/* ═══════ Webhooks Tab ═══════ */}
            {activeTab === 'webhooks' && (
              <div className="space-y-3">
                <div className="flex justify-end">
                  <button onClick={() => setShowNewWebhook(true)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium"
                    style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
                    <Plus className="w-3 h-3" /> Nouveau webhook
                  </button>
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
              <button onClick={saveIntegration} disabled={actionLoading === 'save'}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-medium"
                style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                {actionLoading === 'save' ? 'Sauvegarde...' : 'Sauvegarder & Fermer'}
              </button>
              <button onClick={() => setEditingInteg(null)}
                className="px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                Annuler
              </button>
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
              <button onClick={createWebhook} disabled={!newWebhook.name || actionLoading === 'webhook'}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--accent-primary)', color: '#fff' }}>
                Créer
              </button>
              <button onClick={() => setShowNewWebhook(false)}
                className="px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
