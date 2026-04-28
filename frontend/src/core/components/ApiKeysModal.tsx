import { useState, useEffect } from 'react'
import { X, Key, Plus, Trash2, Eye, EyeOff, Check, Save, RefreshCw } from 'lucide-react'
import { api, apiFetch } from '../services/api'
import { useStore } from '../stores/appStore'

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
  const { selectedProvider, selectedModel, setSelectedProvider, setSelectedModel } = useStore()
  const [providers, setProviders] = useState<Provider[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  // Add-provider form. Deux modes :
  // - 'preset' : provider connu (openrouter/anthropic/openai/google/...) déjà
  //   configuré côté backend (base_url + models pré-définis). L'user fournit
  //   juste sa clé.
  // - 'custom' : provider arbitraire OpenAI-compatible (Groq, Together,
  //   Fireworks, instance Ollama distante…). L'user fournit name + base_url
  //   + api_key + (optionnellement) default_model.
  const [newProvider, setNewProvider] = useState({
    mode: 'preset' as 'preset' | 'custom',
    name: '',
    api_key: '',
    base_url: '',
    default_model: '',
  })
  const [showAddForm, setShowAddForm] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  // Live model lists per provider, fetched from /api/models/{name} when the
  // modal opens. Falls back to the static p.models list if the live fetch
  // fails or returns nothing.
  const [liveModels, setLiveModels] = useState<Record<string, string[]>>({})
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!isOpen || !config?.providers) return
    const list: Provider[] = Object.entries(config.providers).map(([name, p]: [string, any]) => {
      // For the user's active provider, show their selected model
      const userModel = (name === selectedProvider && selectedModel) ? selectedModel : ''
      return {
        name,
        enabled: p?.enabled || false,
        api_key: '',
        default_model: userModel || p?.default_model || '',
        models: p?.models || [],
      }
    })
    setProviders(list)
  }, [isOpen, config, selectedProvider, selectedModel])

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
          // Only mark as "live" when the backend confirms it actually fetched
          // from the provider — avoids showing the static fallback as if it
          // were the real catalog.
          if (data.source === 'live' && Array.isArray(data.models) && data.models.length > 0) {
            setLiveModels(prev => ({ ...prev, [name]: data.models }))
          } else if (data.error) {
            console.warn(`ApiKeysModal: ${name} live fetch failed → ${data.error}`)
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
      // Sauvegarde = le provider + modèle choisis deviennent l'actif global
      // (sinon le paramètre "par défaut" côté modale n'était jamais appliqué).
      if (prov.default_model) {
        setSelectedProvider(providerName)
        setSelectedModel(prov.default_model)
      }
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
    // En mode custom, base_url est requis (sinon le provider est inutilisable).
    if (newProvider.mode === 'custom' && !newProvider.base_url.trim()) {
      setMessage({ type: 'err', text: 'Base URL requise pour un provider personnalisé (ex: https://api.groq.com/openai/v1)' })
      return
    }
    setSaving('new')
    try {
      const payload: any = {
        enabled: true,
        api_key: newProvider.api_key.trim(),
      }
      if (newProvider.mode === 'custom') {
        payload.base_url = newProvider.base_url.trim()
        if (newProvider.default_model.trim()) {
          payload.default_model = newProvider.default_model.trim()
        }
      }
      await api.saveProvider(name, payload)
      const newConfig = await api.getConfig()
      onConfigUpdate(newConfig)
      // Ajouter un provider = le choisir comme actif, avec son default_model.
      const defaultModel = newConfig?.providers?.[name]?.default_model
      setSelectedProvider(name)
      if (defaultModel) setSelectedModel(defaultModel)
      setNewProvider({ mode: 'preset', name: '', api_key: '', base_url: '', default_model: '' })
      setShowAddForm(false)
      setMessage({ type: 'ok', text: `${name} ajouté` })
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message })
    }
    setSaving(null)
  }

  // Liste des providers connus avec config pré-définie côté backend.
  // Pour ceux-là, juste la clé suffit (base_url, models déjà connus).
  const KNOWN_PROVIDER_PRESETS = [
    { id: 'openrouter', label: 'OpenRouter', hint: 'Accès à 250+ modèles via une seule API' },
    { id: 'anthropic',  label: 'Anthropic (Claude)', hint: 'Direct API Claude 4.x' },
    { id: 'openai',     label: 'OpenAI (GPT)', hint: 'Direct API GPT-4/5, o1/o3' },
    { id: 'google',     label: 'Google (Gemini)', hint: 'Gemini 2.x via Generative Language API' },
    { id: 'mistral',    label: 'Mistral AI', hint: 'Direct API Mistral Large/Medium' },
    { id: 'xai',        label: 'xAI (Grok)', hint: 'Direct API Grok 3/4' },
    { id: 'minimax',    label: 'MiniMax', hint: 'API MiniMax M1/abab' },
    { id: 'deepinfra',  label: 'DeepInfra', hint: 'Open-source low-cost (Llama, Qwen, DeepSeek, Mixtral)' },
    { id: 'ollama',     label: 'Ollama (local)', hint: 'Pas de clé requise — instance locale' },
  ]

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
              {prov.name === selectedProvider && selectedModel && (
                <p className="text-[10px]" style={{ color: 'var(--accent-primary)' }}>
                  ● Provider actif — modèle : {selectedModel}
                </p>
              )}
              {config?.providers?.[prov.name]?.has_api_key && (
                <p className="text-[10px]" style={{ color: 'var(--accent-success, #22c55e)' }}>
                  ✓ Clé API configurée
                </p>
              )}

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
              {/* Toggle mode preset / custom */}
              <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                <button onClick={() => setNewProvider(prev => ({ ...prev, mode: 'preset', name: '', base_url: '', default_model: '' }))}
                  className="flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                  style={{
                    background: newProvider.mode === 'preset' ? 'var(--accent-primary)' : 'transparent',
                    color: newProvider.mode === 'preset' ? '#fff' : 'var(--text-secondary)',
                  }}>
                  Provider connu
                </button>
                <button onClick={() => setNewProvider(prev => ({ ...prev, mode: 'custom' }))}
                  className="flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                  style={{
                    background: newProvider.mode === 'custom' ? 'var(--accent-primary)' : 'transparent',
                    color: newProvider.mode === 'custom' ? '#fff' : 'var(--text-secondary)',
                  }}>
                  Personnalisé (avancé)
                </button>
              </div>

              {newProvider.mode === 'preset' ? (
                <>
                  {/* Mode preset : dropdown des providers connus + clé */}
                  <select value={newProvider.name}
                    onChange={e => setNewProvider(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                    <option value="">— Choisis un provider —</option>
                    {KNOWN_PROVIDER_PRESETS
                      .filter(p => !config?.providers?.[p.id]?.has_api_key)  // cache ceux déjà ajoutés
                      .map(p => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                  </select>
                  {newProvider.name && (
                    <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>
                      {KNOWN_PROVIDER_PRESETS.find(p => p.id === newProvider.name)?.hint}
                    </div>
                  )}
                  <input type="password" placeholder={newProvider.name === 'ollama' ? 'Clé non requise (instance locale)' : 'Clé API'}
                    value={newProvider.api_key} onChange={e => setNewProvider(prev => ({ ...prev, api_key: e.target.value }))}
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                </>
              ) : (
                <>
                  {/* Mode custom : tous les champs nécessaires pour un provider OpenAI-compat */}
                  <div>
                    <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Identifiant (lowercase, sans espace)</label>
                    <input type="text" placeholder="ex: groq, fireworks, together..."
                      value={newProvider.name}
                      onChange={e => setNewProvider(prev => ({ ...prev, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Base URL <span style={{ color: 'var(--scarlet)' }}>*</span></label>
                    <input type="text" placeholder="ex: https://api.groq.com/openai/v1"
                      value={newProvider.base_url}
                      onChange={e => setNewProvider(prev => ({ ...prev, base_url: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Clé API</label>
                    <input type="password" placeholder="sk-... / gsk_... / ..."
                      value={newProvider.api_key}
                      onChange={e => setNewProvider(prev => ({ ...prev, api_key: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Modèle par défaut <span style={{ color: 'var(--text-muted)' }}>(optionnel)</span></label>
                    <input type="text" placeholder="ex: llama-3.3-70b-versatile"
                      value={newProvider.default_model}
                      onChange={e => setNewProvider(prev => ({ ...prev, default_model: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  </div>
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Le provider doit être OpenAI-compatible (endpoint <code>/v1/chat/completions</code> et <code>/v1/models</code>).
                    Si tu ne mets pas de modèle par défaut, Gungnir tentera <code>/v1/models</code> pour le détecter.
                  </div>
                </>
              )}

              <div className="flex gap-2">
                <button onClick={handleAddProvider} disabled={saving === 'new'}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: 'var(--text-primary)' }}>
                  <Plus className="w-3.5 h-3.5" /> Ajouter
                </button>
                <button onClick={() => { setShowAddForm(false); setNewProvider({ mode: 'preset', name: '', api_key: '', base_url: '', default_model: '' }) }}
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
