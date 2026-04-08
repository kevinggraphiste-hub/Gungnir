/**
 * Gungnir Plugin — Channels
 * Canaux de communication : Telegram, Discord, Slack, WhatsApp, Email, Widget Web, API.
 * Indépendant — appels directs vers /api/plugins/channels/*.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Radio, RadioTower, Send, MessageCircle, Hash, Phone, Mail, Globe, Code,
  Plus, Trash2, Power, PowerOff, Settings, Copy, Check, ExternalLink,
  ArrowDownLeft, ArrowUpRight, Clock, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Eye, EyeOff, Loader2, X, Link,
  MessageSquare, Activity, FileText, Zap
} from 'lucide-react'

const API = '/api/plugins/channels'

// ── Icon map ───────────────────────────────────────────────────────
const ICONS: Record<string, any> = {
  Send, MessageCircle, Hash, Phone, Mail, Globe, Code, MessageSquare, Radio, RadioTower, Zap
}

const getIcon = (name: string) => ICONS[name] || Radio

// ── Colors par type ────────────────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  telegram: '#0088cc',
  discord: '#5865F2',
  slack: '#4A154B',
  whatsapp: '#25D366',
  email: '#EA4335',
  web_widget: '#dc2626',
  api: '#6366f1',
}

// ── Helpers ────────────────────────────────────────────────────────
const apiFetch = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

const timeAgo = (iso: string | null) => {
  if (!iso) return 'Jamais'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "À l'instant"
  if (mins < 60) return `Il y a ${mins}min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Il y a ${hours}h`
  return `Il y a ${Math.floor(hours / 24)}j`
}

// ── Main Component ─────────────────────────────────────────────────
export default function ChannelsPlugin() {
  const [tab, setTab] = useState<'channels' | 'logs'>('channels')
  const [channels, setChannels] = useState<any[]>([])
  const [catalog, setCatalog] = useState<Record<string, any>>({})
  const [categories, setCategories] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [logs, setLogs] = useState<any[]>([])

  // Modals
  const [showCatalog, setShowCatalog] = useState(false)
  const [editingChannel, setEditingChannel] = useState<any>(null)
  const [editForm, setEditForm] = useState<Record<string, any>>({})
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [webhookUrls, setWebhookUrls] = useState<Record<string, any>>({})
  const [copied, setCopied] = useState<string | null>(null)
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
  const [catalogSearch, setCatalogSearch] = useState('')

  // ── Load data ──────────────────────────────────────────────────
  const loadChannels = useCallback(async () => {
    try {
      const [listRes, catRes] = await Promise.all([
        apiFetch(`${API}/list`),
        apiFetch(`${API}/catalog`),
      ])
      setChannels(listRes.channels || [])
      setCatalog(catRes.channels || {})
      setCategories(catRes.categories || {})
    } catch (e) {
      console.error('Channels load error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      const res = await apiFetch(`${API}/logs?limit=200`)
      setLogs((res.logs || []).reverse())
    } catch (e) {
      console.error('Logs load error:', e)
    }
  }, [])

  useEffect(() => { loadChannels() }, [loadChannels])
  useEffect(() => { if (tab === 'logs') loadLogs() }, [tab, loadLogs])

  // ── Actions ────────────────────────────────────────────────────
  const handleAddChannel = async (type: string) => {
    const catEntry = catalog[type]
    if (!catEntry) return
    try {
      const res = await apiFetch(`${API}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          name: catEntry.display_name,
          config: {},
          enabled: false,
        }),
      })
      if (res.ok) {
        setShowCatalog(false)
        loadChannels()
        // Ouvrir directement l'édition
        setEditingChannel(res.channel)
        setEditForm(res.channel.config || {})
      }
    } catch (e) {
      console.error('Create channel error:', e)
    }
  }

  const [webhookMsg, setWebhookMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const handleToggle = async (id: string) => {
    try {
      const res = await apiFetch(`${API}/${id}/toggle`, { method: 'POST' })
      loadChannels()
      // Show webhook registration result
      if (res.webhook) {
        if (res.webhook.ok) {
          setWebhookMsg({ ok: true, text: res.webhook.webhook_url
            ? `Webhook enregistré ✓`
            : 'Webhook supprimé' })
        } else {
          setWebhookMsg({ ok: false, text: `Webhook: ${res.webhook.error}` })
        }
        setTimeout(() => setWebhookMsg(null), 5000)
      }
    } catch (e) {
      console.error('Toggle error:', e)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Supprimer ce canal ?')) return
    try {
      await apiFetch(`${API}/${id}`, { method: 'DELETE' })
      loadChannels()
    } catch (e) {
      console.error('Delete error:', e)
    }
  }

  const handleEdit = (channel: any) => {
    setEditingChannel(channel)
    setEditForm(channel.config || {})
    setTestResult(null)
    setShowPassword({})
    // Load webhook URLs
    apiFetch(`${API}/${channel.id}/webhook-url`).then(res => {
      setWebhookUrls(res.urls || {})
    }).catch(() => {})
  }

  const handleSave = async () => {
    if (!editingChannel) return
    setSaving(true)
    try {
      const res = await apiFetch(`${API}/${editingChannel.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editingChannel.name,
          config: editForm,
        }),
      })
      // Show webhook registration result
      if (res.webhook) {
        if (res.webhook.ok) {
          setWebhookMsg({ ok: true, text: 'Webhook enregistré automatiquement ✓' })
        } else {
          setWebhookMsg({ ok: false, text: `Webhook: ${res.webhook.error}` })
        }
        setTimeout(() => setWebhookMsg(null), 5000)
      }
      setEditingChannel(null)
      loadChannels()
    } catch (e) {
      console.error('Save error:', e)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    setTestResult(null)
    try {
      const res = await apiFetch(`${API}/${id}/test`, { method: 'POST' })
      setTestResult(res)
    } catch (e) {
      setTestResult({ ok: false, error: String(e) })
    } finally {
      setTesting(null)
    }
  }

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Render helpers ─────────────────────────────────────────────
  const activeCount = channels.filter(c => c.enabled).length

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#dc2626' }} />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-primary)' }}>
        <div className="flex items-center gap-3">
          <RadioTower className="w-5 h-5" style={{ color: '#dc2626' }} />
          <h1 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Channels</h1>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(220,38,38,0.15)', color: '#dc2626' }}>
            {activeCount} actif{activeCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Tabs */}
          {(['channels', 'logs'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-1.5 text-xs rounded-lg transition-colors"
              style={{
                background: tab === t ? 'rgba(220,38,38,0.15)' : 'transparent',
                color: tab === t ? '#dc2626' : 'var(--text-muted)',
              }}
            >
              {t === 'channels' ? 'Canaux' : 'Logs'}
            </button>
          ))}
          <button
            onClick={() => { setShowCatalog(true); setCatalogSearch('') }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{ background: '#dc2626', color: 'white' }}
          >
            <Plus className="w-3.5 h-3.5" />
            Ajouter
          </button>
        </div>
      </div>

      {/* Webhook feedback */}
      {webhookMsg && (
        <div className="mx-6 mt-3 px-4 py-2.5 rounded-lg text-sm flex items-center gap-2"
          style={{
            background: webhookMsg.ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
            color: webhookMsg.ok ? '#22c55e' : '#ef4444',
            border: webhookMsg.ok ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(239,68,68,0.3)',
          }}>
          {webhookMsg.ok ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {webhookMsg.text}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'channels' && (
          <ChannelsList
            channels={channels}
            catalog={catalog}
            expandedChannel={expandedChannel}
            setExpandedChannel={setExpandedChannel}
            onToggle={handleToggle}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
        {tab === 'logs' && (
          <LogsList
            logs={logs}
            onRefresh={loadLogs}
            onClear={async () => {
              await apiFetch(`${API}/logs`, { method: 'DELETE' })
              loadLogs()
            }}
          />
        )}
      </div>

      {/* Catalog Modal */}
      {showCatalog && (
        <CatalogModal
          catalog={catalog}
          categories={categories}
          channels={channels}
          search={catalogSearch}
          setSearch={setCatalogSearch}
          onAdd={handleAddChannel}
          onClose={() => setShowCatalog(false)}
        />
      )}

      {/* Edit Modal */}
      {editingChannel && (
        <EditModal
          channel={editingChannel}
          setChannel={setEditingChannel}
          catalog={catalog}
          form={editForm}
          setForm={setEditForm}
          showPassword={showPassword}
          setShowPassword={setShowPassword}
          webhookUrls={webhookUrls}
          copied={copied}
          onCopy={copyToClipboard}
          testing={testing}
          testResult={testResult}
          onTest={handleTest}
          saving={saving}
          onSave={handleSave}
          onClose={() => setEditingChannel(null)}
        />
      )}
    </div>
  )
}

// ── Channels List ──────────────────────────────────────────────────
function ChannelsList({ channels, catalog, expandedChannel, setExpandedChannel, onToggle, onEdit, onDelete }: any) {
  if (channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3" style={{ color: 'var(--text-muted)' }}>
        <Radio className="w-12 h-12 opacity-30" />
        <p className="text-sm">Aucun canal configuré</p>
        <p className="text-xs opacity-60">Ajoutez un canal pour connecter Gungnir au monde extérieur</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {channels.map((ch: any) => {
        const catEntry = catalog[ch.type] || {}
        const Icon = getIcon(catEntry.icon)
        const color = TYPE_COLORS[ch.type] || '#6366f1'
        const expanded = expandedChannel === ch.id
        const stats = ch.stats || {}

        return (
          <div
            key={ch.id}
            className="rounded-xl border overflow-hidden transition-colors"
            style={{
              borderColor: ch.enabled ? `${color}40` : 'var(--border-primary)',
              background: 'var(--bg-secondary)',
            }}
          >
            {/* Main row */}
            <div className="flex items-center gap-4 px-4 py-3">
              {/* Icon */}
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: `${color}20` }}
              >
                <Icon className="w-5 h-5" style={{ color }} />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                    {ch.name}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{
                      background: ch.enabled ? `${color}20` : 'var(--bg-tertiary)',
                      color: ch.enabled ? color : 'var(--text-muted)',
                    }}
                  >
                    {ch.enabled ? 'Actif' : 'Inactif'}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {catEntry.display_name || ch.type}
                  </span>
                  {stats.messages_in > 0 && (
                    <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                      <ArrowDownLeft className="w-3 h-3" />{stats.messages_in}
                      <ArrowUpRight className="w-3 h-3 ml-1" />{stats.messages_out || 0}
                    </span>
                  )}
                  {stats.last_activity && (
                    <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                      <Clock className="w-3 h-3" />{timeAgo(stats.last_activity)}
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setExpandedChannel(expanded ? null : ch.id)}
                  className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  title="Détails"
                >
                  {expanded ? <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} /> : <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />}
                </button>
                <button
                  onClick={() => onToggle(ch.id)}
                  className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  title={ch.enabled ? 'Désactiver' : 'Activer'}
                >
                  {ch.enabled
                    ? <Power className="w-4 h-4" style={{ color }} />
                    : <PowerOff className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  }
                </button>
                <button
                  onClick={() => onEdit(ch)}
                  className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  title="Configurer"
                >
                  <Settings className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
                <button
                  onClick={() => onDelete(ch.id)}
                  className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                  title="Supprimer"
                >
                  <Trash2 className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
              </div>
            </div>

            {/* Expanded details */}
            {expanded && (
              <div className="px-4 pb-3 pt-1 border-t" style={{ borderColor: 'var(--border-primary)' }}>
                <div className="grid grid-cols-2 gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <div>
                    <span className="opacity-60">Type:</span> {catEntry.display_name}
                  </div>
                  <div>
                    <span className="opacity-60">ID:</span> <code className="text-[11px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)' }}>{ch.id}</code>
                  </div>
                  <div>
                    <span className="opacity-60">Messages reçus:</span> {stats.messages_in || 0}
                  </div>
                  <div>
                    <span className="opacity-60">Messages envoyés:</span> {stats.messages_out || 0}
                  </div>
                  <div>
                    <span className="opacity-60">Créé:</span> {ch.created_at ? new Date(ch.created_at).toLocaleDateString('fr-FR') : '—'}
                  </div>
                  <div>
                    <span className="opacity-60">Dernière activité:</span> {timeAgo(stats.last_activity)}
                  </div>
                </div>
                {catEntry.doc_url && (
                  <a
                    href={catEntry.doc_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-xs hover:underline"
                    style={{ color }}
                  >
                    <ExternalLink className="w-3 h-3" />Documentation
                  </a>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Catalog Modal ──────────────────────────────────────────────────
function CatalogModal({ catalog, categories, channels, search, setSearch, onAdd, onClose }: any) {
  const existingTypes = new Set(channels.map((c: any) => c.type))
  const filtered = Object.entries(catalog).filter(([key, val]: [string, any]) => {
    if (!search) return true
    return val.display_name.toLowerCase().includes(search.toLowerCase()) ||
           val.description.toLowerCase().includes(search.toLowerCase())
  })

  // Group by category
  const byCategory: Record<string, [string, any][]> = {}
  for (const [key, val] of filtered) {
    const cat = (val as any).category || 'autre'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push([key, val])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border-primary)' }}>
          <h3 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Ajouter un canal</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5">
            <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher..."
            className="w-full px-3 py-2 rounded-lg text-sm border-none outline-none"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          />
        </div>

        {/* List */}
        <div className="px-5 pb-5 max-h-[60vh] overflow-y-auto space-y-4">
          {Object.entries(byCategory).map(([catKey, items]) => {
            const catInfo = categories[catKey] || { label: catKey }
            return (
              <div key={catKey}>
                <h4 className="text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                  {catInfo.label}
                </h4>
                <div className="space-y-2">
                  {items.map(([key, val]: [string, any]) => {
                    const Icon = getIcon(val.icon)
                    const color = TYPE_COLORS[key] || '#6366f1'
                    const alreadyAdded = existingTypes.has(key)
                    return (
                      <div
                        key={key}
                        className="flex items-center gap-3 p-3 rounded-lg border transition-colors"
                        style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}
                      >
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: `${color}20` }}
                        >
                          <Icon className="w-4 h-4" style={{ color }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{val.display_name}</span>
                            {val.complexity && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{
                                background: val.complexity === 'facile' ? 'rgba(34,197,94,0.15)' : val.complexity === 'moyen' ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)',
                                color: val.complexity === 'facile' ? '#22c55e' : val.complexity === 'moyen' ? '#eab308' : '#ef4444',
                              }}>
                                {val.complexity}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] mt-0.5 line-clamp-1" style={{ color: 'var(--text-muted)' }}>{val.description}</div>
                        </div>
                        <button
                          onClick={() => onAdd(key)}
                          disabled={alreadyAdded}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                          style={{
                            background: alreadyAdded ? 'var(--bg-tertiary)' : `${color}20`,
                            color: alreadyAdded ? 'var(--text-muted)' : color,
                            cursor: alreadyAdded ? 'default' : 'pointer',
                          }}
                        >
                          {alreadyAdded ? 'Ajouté' : 'Ajouter'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Edit Modal ─────────────────────────────────────────────────────
function EditModal({ channel, setChannel, catalog, form, setForm, showPassword, setShowPassword, webhookUrls, copied, onCopy, testing, testResult, onTest, saving, onSave, onClose }: any) {
  const catEntry = catalog[channel.type] || {}
  const fields = catEntry.fields || []
  const color = TYPE_COLORS[channel.type] || '#6366f1'
  const Icon = getIcon(catEntry.icon)
  const [registering, setRegistering] = useState(false)
  const [registerResult, setRegisterResult] = useState<any>(null)

  const handleRegisterWebhook = async () => {
    setRegistering(true)
    setRegisterResult(null)
    try {
      const res = await apiFetch(`${API}/${channel.id}/register-webhook`, { method: 'POST' })
      setRegisterResult(res)
    } catch (e) {
      setRegisterResult({ ok: false, error: String(e) })
    } finally {
      setRegistering(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border shadow-2xl overflow-hidden"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border-primary)' }}>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${color}20` }}>
            <Icon className="w-4 h-4" style={{ color }} />
          </div>
          <div className="flex-1">
            <input
              value={channel.name}
              onChange={e => setChannel({ ...channel, name: e.target.value })}
              className="font-bold text-sm bg-transparent border-none outline-none w-full"
              style={{ color: 'var(--text-primary)' }}
            />
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{catEntry.display_name} — {channel.id}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/5">
            <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Fields */}
        <div className="px-5 py-4 max-h-[50vh] overflow-y-auto space-y-3">
          {/* Setup guide */}
          {catEntry.setup_guide && (
            <div className="p-3 rounded-lg text-xs leading-relaxed" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              {catEntry.setup_guide.split('\n').map((line: string, i: number) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          {fields.map((field: any) => (
            <div key={field.key}>
              <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-muted)' }}>
                {field.label} {field.required && <span style={{ color: '#dc2626' }}>*</span>}
              </label>
              <div className="relative">
                <input
                  type={field.type === 'password' && !showPassword[field.key] ? 'password' : 'text'}
                  value={form[field.key] || ''}
                  onChange={e => setForm({ ...form, [field.key]: e.target.value })}
                  placeholder={field.placeholder || ''}
                  className="w-full px-3 py-2 rounded-lg text-sm border-none outline-none pr-10"
                  style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                />
                {field.type === 'password' && (
                  <button
                    onClick={() => setShowPassword({ ...showPassword, [field.key]: !showPassword[field.key] })}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-white/5"
                  >
                    {showPassword[field.key]
                      ? <EyeOff className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                      : <Eye className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                    }
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* Webhook URLs */}
          {Object.keys(webhookUrls).length > 0 && (
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border-primary)' }}>
              <label className="text-xs font-medium mb-2 block flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                <Link className="w-3 h-3" />URLs Webhook
              </label>
              {Object.entries(webhookUrls).map(([key, url]: [string, any]) => (
                <div key={key} className="flex items-center gap-2 mb-1.5">
                  <code
                    className="flex-1 text-[11px] px-2 py-1.5 rounded truncate"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                  >
                    {String(url)}
                  </code>
                  <button
                    onClick={() => onCopy(String(url), key)}
                    className="p-1 rounded hover:bg-white/5 flex-shrink-0"
                    title="Copier"
                  >
                    {copied === key
                      ? <Check className="w-3.5 h-3.5" style={{ color: '#22c55e' }} />
                      : <Copy className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                    }
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Register webhook button (Telegram, etc.) */}
          {['telegram', 'slack', 'whatsapp'].includes(channel.type) && (
            <div className="pt-2">
              <button
                onClick={handleRegisterWebhook}
                disabled={registering}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ background: `${color}20`, color }}
              >
                {registering
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Zap className="w-3.5 h-3.5" />
                }
                {registering ? 'Enregistrement...' : 'Enregistrer le Webhook'}
              </button>
              {registerResult && (
                <div
                  className="mt-2 p-2.5 rounded-lg text-xs"
                  style={{
                    background: registerResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                    color: registerResult.ok ? '#22c55e' : '#ef4444',
                  }}
                >
                  {registerResult.ok
                    ? `Webhook enregistré ✓${registerResult.webhook_url ? ` → ${registerResult.webhook_url}` : ''}`
                    : `Erreur — ${registerResult.error}`}
                </div>
              )}
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className="p-3 rounded-lg text-xs"
              style={{
                background: testResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                color: testResult.ok ? '#22c55e' : '#ef4444',
              }}
            >
              {testResult.ok ? `Connecté — ${testResult.info}` : `Erreur — ${testResult.error}`}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: 'var(--border-primary)' }}>
          <button
            onClick={() => onTest(channel.id)}
            disabled={testing === channel.id}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
          >
            {testing === channel.id
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Activity className="w-3.5 h-3.5" />
            }
            Tester
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              Annuler
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: color, color: 'white' }}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Logs List ──────────────────────────────────────────────────────
function LogsList({ logs, onRefresh, onClear }: any) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{logs.length} événements</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            <RefreshCw className="w-3 h-3" />Rafraîchir
          </button>
          {logs.length > 0 && (
            <button
              onClick={onClear}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/5 transition-colors"
              style={{ color: '#ef4444' }}
            >
              <Trash2 className="w-3 h-3" />Vider
            </button>
          )}
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Aucun log</p>
        </div>
      ) : (
        <div className="space-y-1">
          {logs.map((log: any) => (
            <div
              key={log.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
              style={{ background: 'var(--bg-secondary)' }}
            >
              {log.direction === 'in' && <ArrowDownLeft className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#3b82f6' }} />}
              {log.direction === 'out' && <ArrowUpRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#22c55e' }} />}
              {log.direction === 'system' && <Settings className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
              <span className="font-medium flex-shrink-0" style={{ color: 'var(--text-primary)', minWidth: 80 }}>
                {log.channel_name}
              </span>
              <span className="flex-1 truncate" style={{ color: 'var(--text-muted)' }}>
                {log.summary}
              </span>
              {log.status === 'error' && (
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#ef4444' }} />
              )}
              <span className="flex-shrink-0 opacity-50" style={{ color: 'var(--text-muted)' }}>
                {log.timestamp ? new Date(log.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
