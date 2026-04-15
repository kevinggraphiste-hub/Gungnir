import { useState, useEffect } from 'react'
import { X, Key, Plus, Trash2, Eye, EyeOff, Check, Save, RefreshCw } from 'lucide-react'
import { api, apiFetch } from '../services/api'

interface Provider {
  name: string
  enabled: boolean
  api_key: string
  default_model: string
  models: string[]
}

interface Props {
  isOpen: boolean
  onClose: () => void
  config: any
  onConfigUpdate: (config: any) => void
}

export default function ApiKeysModal({ isOpen, onClose, config, onConfigUpdate }: Props) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [newProvider, setNewProvider] = useState({ name: '', api_key: '' })
  const [showAddForm, setShowAddForm] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  // Live model lists per provider, fetched from /api/models/{name} when the
  // modal opens. Falls back to the static p.models list if the live fetch
  // fails or returns nothing.
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({})
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!isOpen || !config?.providers) return
    const list: Provider[] = Object.entries(config.providers).map(([name, p]: [string, any]) => ({
      name,
      enabled: p?.enabled || false,
      api_key: '',
      default_model: p?.default_model || '',
      models: p?.models || [],
    }))
    setProviders(list)
  }, [isOpen, config])

  // Fetch live model lists every time the modal opens, for every provider
  // that is enabled or has a key — same flow as Settings → Providers.
  const loadLive = async (force = false) => {
    if (!config?.providers) return
    const targets = Object.entries(config.providers)
      .filter(([, p]: [string, any]) => p?.enabled || p?.has_api_key)
      .map(([name]) => name)
    for (const name of targets) {
      if (!force && liveModels[name]?.length) continue
      setLoadingModels(prev => ({ ...prev, [name]: true }))
      try {
        const res = await apiFetch(`/api/models/${name}`)
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.models) && data.models.length > 0) {
            setLiveModels(prev => ({ ...prev, [name]: data.models }))
          }
        }
      } catch (err) {
        console.warn(`ApiKeysModal: live models fetch failed for ${name}:`, err)
      }
      setLoadingModels(prev => ({ ...prev, [name]: false }))
    }
  }

  useEffect(() => {
    if (isOpen) loadLive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, config])

  const handleSave = async (providerName: string) => {
    const prov = providers.find(p => p.name === providerName)
    if (!prov) return
    setSaving(providerName)
    setMessage(null)
    try {
      // Si une nouvelle clé est saisie, activer automatiquement le provider
      const data: any = { enabled: prov.api_key ? true : prov.enabled }
      if (prov.api_key) data.api_key = prov.api_key.trim()
      if (prov.default_model) data.default_model = prov.default_model
      await api.saveProvider(providerName, data)
      const newConfig = await api.getConfig()
      onConfigUpdate(newConfig)
      setMessage({ type: 'ok', text: `${providerName} sauvegardé` })
      setTimeout(() => setMessage(null), 2000)
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message })
    }
    setSaving(null)
  }

  const handleDelete = async (providerName: string) => {
    if (!confirm(`Supprimer le provider "${providerName}" ?`)) return
    try {
      await api.deleteProvider(providerName)
      const newConfig = await api.getConfig()
      onConfigUpdate(newConfig)
      setProviders(prev => prev.filter(p => p.name !== providerName))
      setMessage({ type: 'ok', text: `${providerName} supprimé` })
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message })
    }
  }

  const handleAddProvider = async () => {
    const name = newProvider.name.trim().toLowerCase()
    if (!name || !newProvider.api_key.trim()) return
    setSaving('new')
    try {
      await api.saveProvider(name, { enabled: true, api_key: newProvider.api_key.trim() })
      const newConfig = await api.getConfig()
      onConfigUpdate(newConfig)
      setNewProvider({ name: '', api_key: '' })
      setShowAddForm(false)
      setMessage({ type: 'ok', text: `${name} ajouté` })
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message })
    }
    setSaving(null)
  }

  const updateProvider = (name: string, field: string, value: any) => {
    setProviders(prev => prev.map(p => p.name === name ? { ...p, [field]: value } : p))
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>
              <Key className="w-5 h-5" style={{ color: 'var(--accent-primary-light)' }} />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Clés API</h2>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Gérer vos providers et clés</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => loadLive(true)} title="Rafraîchir les modèles live"
              className="p-2 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}>
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Message */}
        {message && (
          <div className="mx-6 mt-4 px-3 py-2 rounded-lg text-sm flex items-center gap-2"
            style={{
              background: message.type === 'ok' ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
              color: message.type === 'ok' ? 'var(--accent-success)' : 'var(--accent-primary-light)',
              border: message.type === 'ok' ? '1px solid color-mix(in srgb, var(--accent-success) 30%, transparent)' : '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
            }}>
            {message.type === 'ok' ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
            {message.text}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {providers.map(prov => (
            <div key={prov.name} className="rounded-xl p-4 space-y-3" style={{ border: '1px solid var(--border-subtle)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="w-2 h-2 rounded-full" style={{ background: prov.enabled ? 'var(--accent-success)' : 'var(--text-muted)' }} />
                  <span className="font-medium capitalize" style={{ color: 'var(--text-primary)' }}>{prov.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={prov.enabled}
                      onChange={e => updateProvider(prov.name, 'enabled', e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-red-600" />
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Actif</span>
                  </label>
                  <button onClick={() => handleDelete(prov.name)}
                    className="p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }} title="Supprimer">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="relative">
                <input
                  type={showKey[prov.name] ? 'text' : 'password'}
                  placeholder="Nouvelle clé API (laisser vide pour garder l'actuelle)"
                  value={prov.api_key}
                  onChange={e => updateProvider(prov.name, 'api_key', e.target.value)}
                  className="w-full rounded-lg px-3 py-2 pr-10 text-sm focus:outline-none"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                />
                <button onClick={() => setShowKey(prev => ({ ...prev, [prov.name]: !prev[prov.name] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1" style={{ color: 'var(--text-muted)' }}>
                  {showKey[prov.name] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>

              {(() => {
                const live = liveModels[prov.name]
                const allModels = (live && live.length > 0) ? live : prov.models
                if (allModels.length === 0) return null
                const sorted = [...allModels].sort()
                return (
                  <div>
                    <div className="flex items-center justify-between text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      <span>
                        {live && live.length > 0
                          ? `${sorted.length} modèle${sorted.length > 1 ? 's' : ''} live`
                          : `${sorted.length} modèle${sorted.length > 1 ? 's' : ''} (statique)`}
                      </span>
                      {loadingModels[prov.name] && <span>chargement…</span>}
                    </div>
                    <select value={prov.default_model}
                      onChange={e => updateProvider(prov.name, 'default_model', e.target.value)}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                      {sorted.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )
              })()}

              <button onClick={() => handleSave(prov.name)} disabled={saving === prov.name}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50 transition-colors"
                style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: 'var(--text-primary)' }}>
                <Save className="w-3.5 h-3.5" />
                {saving === prov.name ? 'Sauvegarde...' : 'Sauvegarder'}
              </button>
            </div>
          ))}

          {showAddForm ? (
            <div className="border border-dashed rounded-xl p-4 space-y-3" style={{ borderColor: 'var(--border)' }}>
              <input type="text" placeholder="Nom du provider (ex: openrouter, anthropic...)"
                value={newProvider.name} onChange={e => setNewProvider(prev => ({ ...prev, name: e.target.value }))}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <input type="password" placeholder="Clé API"
                value={newProvider.api_key} onChange={e => setNewProvider(prev => ({ ...prev, api_key: e.target.value }))}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <div className="flex gap-2">
                <button onClick={handleAddProvider} disabled={saving === 'new'}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: 'var(--text-primary)' }}>
                  <Plus className="w-3.5 h-3.5" /> Ajouter
                </button>
                <button onClick={() => { setShowAddForm(false); setNewProvider({ name: '', api_key: '' }) }}
                  className="px-3 py-2 rounded-lg text-sm" style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAddForm(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
              <Plus className="w-4 h-4" /> Ajouter un provider
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
