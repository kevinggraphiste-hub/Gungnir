/**
 * Gungnir Plugin — Channels
 * Canaux de communication : Telegram, Discord, Slack, WhatsApp, Email, Widget Web, API.
 * Aligné sur le design system Conscience.
 */
import { useState, useEffect, useCallback } from 'react'
import InfoButton from '@core/components/InfoButton'
import {
  Radio, RadioTower, Send, MessageCircle, Hash, Phone, Mail, Globe, Code,
  Plus, Trash2, Power, PowerOff, Settings, Copy, Check, ExternalLink,
  ArrowDownLeft, ArrowUpRight, Clock, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Eye, EyeOff, Loader2, X, Link,
  MessageSquare, Activity, FileText, Zap,
} from 'lucide-react'
import {
  PageHeader, TabBar, SectionCard, SectionTitle,
  PrimaryButton, SecondaryButton, FormInput, Badge,
} from '@core/components/ui'

const API = '/api/plugins/channels'

// ── Icon map ───────────────────────────────────────────────────────
const ICONS: Record<string, any> = {
  Send, MessageCircle, Hash, Phone, Mail, Globe, Code, MessageSquare, Radio, RadioTower, Zap,
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

type Tab = 'channels' | 'logs'

const TABS = [
  { key: 'channels' as const, label: 'Canaux', icon: <RadioTower size={14} /> },
  { key: 'logs' as const, label: 'Logs', icon: <FileText size={14} /> },
]

// ── Main Component ─────────────────────────────────────────────────
export default function ChannelsPlugin() {
  const [tab, setTab] = useState<Tab>('channels')
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
      if (res.webhook) {
        if (res.webhook.ok) {
          setWebhookMsg({ ok: true, text: res.webhook.webhook_url ? 'Webhook enregistré ✓' : 'Webhook supprimé' })
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

  const activeCount = channels.filter(c => c.enabled).length

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--scarlet)' }} />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          icon={<RadioTower size={18} />}
          title="Channels"
          version="1.1.0"
          subtitle={<span>Canaux d'entrée / sortie de ton agent <InfoButton>
            <strong>Les channels</strong> sont les portes d'entrée par lesquelles ton agent reçoit des messages de l'extérieur : Telegram, Discord, Slack, WhatsApp, email, widget web, API HTTP…
            <br /><br />
            Chaque canal a un webhook entrant qu'un service tiers appelle quand un message arrive. Ton agent répond ensuite via le même canal.
            <br /><br />
            Les canaux sont <em>per-user</em> : les messages qui arrivent sur ton Telegram déclenchent uniquement <em>ton</em> agent, avec <em>tes</em> clés API et <em>ta</em> config.
          </InfoButton></span> as any}
          actions={
            <>
              <Badge>{activeCount} actif{activeCount !== 1 ? 's' : ''}</Badge>
              <PrimaryButton size="sm" icon={<Plus size={14} />} onClick={() => { setShowCatalog(true); setCatalogSearch('') }}>
                Ajouter
              </PrimaryButton>
            </>
          }
        />
      </div>

      <div style={{ padding: '0 24px 12px' }}>
        <TabBar tabs={TABS} active={tab} onChange={setTab} />
      </div>

      {webhookMsg && (
        <div style={{
          margin: '0 24px 12px', padding: '10px 14px', borderRadius: 10, fontSize: 'var(--font-md)',
          display: 'flex', alignItems: 'center', gap: 8,
          background: `color-mix(in srgb, ${webhookMsg.ok ? '#22c55e' : '#ef4444'} 12%, transparent)`,
          color: webhookMsg.ok ? '#22c55e' : '#ef4444',
          border: `1px solid color-mix(in srgb, ${webhookMsg.ok ? '#22c55e' : '#ef4444'} 30%, transparent)`,
        }}>
          {webhookMsg.ok ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {webhookMsg.text}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {tab === 'channels' && (
          <ChannelsList
            channels={channels}
            catalog={catalog}
            expandedChannel={expandedChannel}
            setExpandedChannel={setExpandedChannel}
            onToggle={handleToggle}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onOpenCatalog={() => { setShowCatalog(true); setCatalogSearch('') }}
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
function ChannelsList({ channels, catalog, expandedChannel, setExpandedChannel, onToggle, onEdit, onDelete, onOpenCatalog }: any) {
  if (channels.length === 0) {
    return (
      <SectionCard>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 20px', gap: 12, textAlign: 'center' }}>
          <Radio className="w-10 h-10" style={{ opacity: 0.35, color: 'var(--text-muted)' }} />
          <p style={{ fontSize: 'var(--font-base)', fontWeight: 600, color: 'var(--text-primary)' }}>Aucun canal configuré</p>
          <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-muted)', maxWidth: 460, lineHeight: 1.6 }}>
            Un canal connecte ton agent à une plateforme externe (Telegram, Discord, Slack, email, widget…) pour qu'il puisse recevoir et répondre à des messages sans passer par cette interface.
          </p>
          <PrimaryButton size="sm" icon={<Plus size={14} />} onClick={onOpenCatalog}>
            Parcourir le catalogue
          </PrimaryButton>
        </div>
      </SectionCard>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {channels.map((ch: any) => {
        const catEntry = catalog[ch.type] || {}
        const Icon = getIcon(catEntry.icon)
        const color = TYPE_COLORS[ch.type] || '#6366f1'
        const expanded = expandedChannel === ch.id
        const stats = ch.stats || {}

        return (
          <SectionCard key={ch.id} accent={ch.enabled ? color : undefined} padding="sm">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `color-mix(in srgb, ${color} 15%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
                flexShrink: 0,
              }}>
                <Icon className="w-5 h-5" style={{ color }} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 'var(--font-base)', color: 'var(--text-primary)' }}>{ch.name}</span>
                  <Badge color={ch.enabled ? color : 'var(--text-muted)'}>
                    {ch.enabled ? 'Actif' : 'Inactif'}
                  </Badge>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 3, fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                  <span>{catEntry.display_name || ch.type}</span>
                  {stats.messages_in > 0 && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <ArrowDownLeft className="w-3 h-3" />{stats.messages_in}
                      <ArrowUpRight className="w-3 h-3" style={{ marginLeft: 4 }} />{stats.messages_out || 0}
                    </span>
                  )}
                  {stats.last_activity && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Clock className="w-3 h-3" />{timeAgo(stats.last_activity)}
                    </span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconButton onClick={() => setExpandedChannel(expanded ? null : ch.id)} title="Détails">
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </IconButton>
                <IconButton onClick={() => onToggle(ch.id)} title={ch.enabled ? 'Désactiver' : 'Activer'} color={ch.enabled ? color : undefined}>
                  {ch.enabled ? <Power size={16} /> : <PowerOff size={16} />}
                </IconButton>
                <IconButton onClick={() => onEdit(ch)} title="Configurer">
                  <Settings size={16} />
                </IconButton>
                <IconButton onClick={() => onDelete(ch.id)} title="Supprimer" color="#ef4444">
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </div>

            {expanded && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 'var(--font-sm)', color: 'var(--text-muted)' }}>
                  <div><span style={{ opacity: 0.6 }}>Type :</span> {catEntry.display_name}</div>
                  <div>
                    <span style={{ opacity: 0.6 }}>ID :</span>{' '}
                    <code style={{ fontSize: 'var(--font-xs)', padding: '2px 6px', borderRadius: 4, background: 'var(--bg-tertiary)' }}>{ch.id}</code>
                  </div>
                  <div><span style={{ opacity: 0.6 }}>Messages reçus :</span> {stats.messages_in || 0}</div>
                  <div><span style={{ opacity: 0.6 }}>Messages envoyés :</span> {stats.messages_out || 0}</div>
                  <div><span style={{ opacity: 0.6 }}>Créé :</span> {ch.created_at ? new Date(ch.created_at).toLocaleDateString('fr-FR') : '—'}</div>
                  <div><span style={{ opacity: 0.6 }}>Dernière activité :</span> {timeAgo(stats.last_activity)}</div>
                </div>
                {catEntry.doc_url && (
                  <a href={catEntry.doc_url} target="_blank" rel="noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 10, fontSize: 'var(--font-sm)', color, textDecoration: 'none' }}>
                    <ExternalLink className="w-3 h-3" />Documentation
                  </a>
                )}
              </div>
            )}
          </SectionCard>
        )
      })}
    </div>
  )
}

// ── Icon Button (shared helper for list row actions) ───────────────
function IconButton({ children, onClick, title, color }: any) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: 6, borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer',
        color: color || 'var(--text-muted)',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--scarlet) 8%, transparent)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  )
}

// ── Catalog Modal ──────────────────────────────────────────────────
function CatalogModal({ catalog, categories, channels, search, setSearch, onAdd, onClose }: any) {
  const existingTypes = new Set(channels.map((c: any) => c.type))
  const filtered = Object.entries(catalog).filter(([_key, val]: [string, any]) => {
    if (!search) return true
    return val.display_name.toLowerCase().includes(search.toLowerCase()) ||
           val.description.toLowerCase().includes(search.toLowerCase())
  })

  const byCategory: Record<string, [string, any][]> = {}
  for (const [key, val] of filtered) {
    const cat = (val as any).category || 'autre'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push([key, val])
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)',
    }} onClick={onClose}>
      <div
        style={{
          width: '100%', maxWidth: 560, borderRadius: 16, overflow: 'hidden',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
        }}>
          <h3 style={{ fontSize: 'var(--font-base)', fontWeight: 700, color: 'var(--text-primary)' }}>Ajouter un canal</h3>
          <IconButton onClick={onClose} title="Fermer"><X size={16} /></IconButton>
        </div>

        <div style={{ padding: '14px 20px' }}>
          <FormInput
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher..."
          />
        </div>

        <div style={{ padding: '0 20px 20px', maxHeight: '60vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {Object.entries(byCategory).map(([catKey, items]) => {
            const catInfo = categories[catKey] || { label: catKey }
            return (
              <div key={catKey}>
                <div style={{
                  fontSize: 'var(--font-xs)', fontWeight: 700, marginBottom: 8, textTransform: 'uppercase',
                  letterSpacing: 1.5, color: 'var(--text-muted)',
                }}>
                  {catInfo.label}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map(([key, val]: [string, any]) => {
                    const Icon = getIcon(val.icon)
                    const color = TYPE_COLORS[key] || '#6366f1'
                    const alreadyAdded = existingTypes.has(key)
                    const complexColor =
                      val.complexity === 'facile' ? '#22c55e' :
                      val.complexity === 'moyen' ? '#eab308' : '#ef4444'
                    return (
                      <div key={key} style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: 12,
                        borderRadius: 10, background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-subtle)',
                      }}>
                        <div style={{
                          width: 36, height: 36, borderRadius: 10, display: 'flex',
                          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                          background: `color-mix(in srgb, ${color} 15%, transparent)`,
                          border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
                        }}>
                          <Icon className="w-4 h-4" style={{ color }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text-primary)' }}>{val.display_name}</span>
                            {val.complexity && <Badge color={complexColor}>{val.complexity}</Badge>}
                          </div>
                          <div style={{ fontSize: 'var(--font-xs)', marginTop: 2, color: 'var(--text-muted)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {val.description}
                          </div>
                        </div>
                        {alreadyAdded ? (
                          <SecondaryButton size="sm" disabled>Ajouté</SecondaryButton>
                        ) : (
                          <PrimaryButton size="sm" icon={<Plus size={12} />} onClick={() => onAdd(key)}>
                            Ajouter
                          </PrimaryButton>
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
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)',
    }} onClick={onClose}>
      <div
        style={{
          width: '100%', maxWidth: 520, borderRadius: 16, overflow: 'hidden',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            background: `color-mix(in srgb, ${color} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
          }}>
            <Icon className="w-4 h-4" style={{ color }} />
          </div>
          <div style={{ flex: 1 }}>
            <input
              value={channel.name}
              onChange={e => setChannel({ ...channel, name: e.target.value })}
              style={{
                fontWeight: 700, fontSize: 'var(--font-base)', background: 'transparent',
                border: 'none', outline: 'none', width: '100%', color: 'var(--text-primary)',
              }}
            />
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>{catEntry.display_name} — {channel.id}</div>
          </div>
          <IconButton onClick={onClose} title="Fermer"><X size={16} /></IconButton>
        </div>

        <div style={{ padding: '16px 20px', maxHeight: '55vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {catEntry.setup_guide && (
            <div style={{
              padding: 12, borderRadius: 10, fontSize: 'var(--font-sm)', lineHeight: 1.6,
              background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
              border: '1px solid var(--border-subtle)',
            }}>
              {catEntry.setup_guide.split('\n').map((line: string, i: number) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          )}

          {fields.map((field: any) => (
            <div key={field.key} style={{ position: 'relative' }}>
              <FormInput
                label={field.label + (field.required ? ' *' : '')}
                type={field.type === 'password' && !showPassword[field.key] ? 'password' : 'text'}
                value={form[field.key] || ''}
                onChange={e => setForm({ ...form, [field.key]: e.target.value })}
                placeholder={field.placeholder || ''}
              />
              {field.type === 'password' && (
                <button
                  onClick={() => setShowPassword({ ...showPassword, [field.key]: !showPassword[field.key] })}
                  style={{
                    position: 'absolute', right: 10, top: 34,
                    padding: 4, background: 'transparent', border: 'none', cursor: 'pointer',
                    color: 'var(--text-muted)',
                  }}
                >
                  {showPassword[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
            </div>
          ))}

          {Object.keys(webhookUrls).length > 0 && (
            <div style={{ paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
              <SectionTitle icon={<Link size={12} />}>URLs Webhook</SectionTitle>
              {Object.entries(webhookUrls).map(([key, url]: [string, any]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <code style={{
                    flex: 1, fontSize: 'var(--font-xs)', padding: '6px 10px', borderRadius: 6,
                    background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {String(url)}
                  </code>
                  <IconButton onClick={() => onCopy(String(url), key)} title="Copier" color={copied === key ? '#22c55e' : undefined}>
                    {copied === key ? <Check size={14} /> : <Copy size={14} />}
                  </IconButton>
                </div>
              ))}
            </div>
          )}

          {['telegram', 'slack', 'whatsapp'].includes(channel.type) && (
            <div style={{ paddingTop: 8 }}>
              <SecondaryButton
                size="sm"
                icon={registering ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                onClick={handleRegisterWebhook}
                disabled={registering}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {registering ? 'Enregistrement...' : 'Enregistrer le Webhook'}
              </SecondaryButton>
              {registerResult && (
                <div style={{
                  marginTop: 8, padding: 10, borderRadius: 8, fontSize: 'var(--font-sm)',
                  background: `color-mix(in srgb, ${registerResult.ok ? '#22c55e' : '#ef4444'} 10%, transparent)`,
                  color: registerResult.ok ? '#22c55e' : '#ef4444',
                  border: `1px solid color-mix(in srgb, ${registerResult.ok ? '#22c55e' : '#ef4444'} 25%, transparent)`,
                }}>
                  {registerResult.ok
                    ? `Webhook enregistré ✓${registerResult.webhook_url ? ` → ${registerResult.webhook_url}` : ''}`
                    : `Erreur — ${registerResult.error}`}
                </div>
              )}
            </div>
          )}

          {testResult && (
            <div style={{
              padding: 12, borderRadius: 10, fontSize: 'var(--font-sm)',
              background: `color-mix(in srgb, ${testResult.ok ? '#22c55e' : '#ef4444'} 10%, transparent)`,
              color: testResult.ok ? '#22c55e' : '#ef4444',
              border: `1px solid color-mix(in srgb, ${testResult.ok ? '#22c55e' : '#ef4444'} 25%, transparent)`,
            }}>
              {testResult.ok ? `Connecté — ${testResult.info}` : `Erreur — ${testResult.error}`}
            </div>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px', borderTop: '1px solid var(--border-subtle)',
        }}>
          <SecondaryButton
            size="sm"
            icon={testing === channel.id ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
            onClick={() => onTest(channel.id)}
            disabled={testing === channel.id}
          >
            Tester
          </SecondaryButton>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SecondaryButton size="sm" onClick={onClose}>Annuler</SecondaryButton>
            <PrimaryButton
              size="sm"
              icon={saving ? <Loader2 size={14} className="animate-spin" /> : undefined}
              onClick={onSave}
              disabled={saving}
            >
              Enregistrer
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Logs List ──────────────────────────────────────────────────────
function LogsList({ logs, onRefresh, onClear }: any) {
  return (
    <SectionCard>
      <SectionTitle
        icon={<FileText size={12} />}
        right={
          <>
            <SecondaryButton size="sm" icon={<RefreshCw size={12} />} onClick={onRefresh}>Rafraîchir</SecondaryButton>
            {logs.length > 0 && (
              <SecondaryButton size="sm" danger icon={<Trash2 size={12} />} onClick={onClear}>Vider</SecondaryButton>
            )}
          </>
        }
      >
        {logs.length} événements
      </SectionTitle>

      {logs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          <FileText className="w-8 h-8" style={{ margin: '0 auto 8px', opacity: 0.3 }} />
          <p style={{ fontSize: 'var(--font-md)' }}>Aucun log</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {logs.map((log: any) => (
            <div key={log.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '8px 12px', borderRadius: 8, fontSize: 'var(--font-sm)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-subtle)',
            }}>
              {log.direction === 'in' && <ArrowDownLeft className="w-3.5 h-3.5" style={{ color: '#3b82f6', flexShrink: 0 }} />}
              {log.direction === 'out' && <ArrowUpRight className="w-3.5 h-3.5" style={{ color: '#22c55e', flexShrink: 0 }} />}
              {log.direction === 'system' && <Settings className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />}
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: 80, flexShrink: 0 }}>{log.channel_name}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                {log.summary}
              </span>
              {log.status === 'error' && (
                <AlertTriangle className="w-3.5 h-3.5" style={{ color: '#ef4444', flexShrink: 0 }} />
              )}
              <span style={{ opacity: 0.5, color: 'var(--text-muted)', flexShrink: 0 }}>
                {log.timestamp ? new Date(log.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}
