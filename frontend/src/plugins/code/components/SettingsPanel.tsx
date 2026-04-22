import { useState, useEffect, useCallback } from 'react'
import type { ProviderInfo } from '../types'
import { apiFetch, MONO, S } from '../utils'
import { GitCredentialsPanel } from './GitPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL (with model selector)
// ═══════════════════════════════════════════════════════════════════════════════

// Must match backend/core/providers/__init__.py PROVIDERS (registered classes).
// Ajouter un provider ici sans backend correspondant crée une cle "orpheline"
// que le backend stocke mais ne peut pas appeler.
const PROVIDER_PRESETS: { id: string; label: string; hint: string; baseUrlPlaceholder?: string }[] = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'Claude + GPT + 200 modeles via cle unique' },
  { id: 'anthropic', label: 'Anthropic (Claude API)', hint: 'console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', hint: 'platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Gemini', hint: 'aistudio.google.com/apikey' },
  { id: 'mistral', label: 'Mistral', hint: 'console.mistral.ai/api-keys' },
  { id: 'xai', label: 'xAI (Grok)', hint: 'console.x.ai' },
  { id: 'minimax', label: 'MiniMax', hint: 'api.minimax.chat' },
  { id: 'ollama', label: 'Ollama (local)', hint: 'base URL http://localhost:11434', baseUrlPlaceholder: 'http://localhost:11434' },
]

export const PROVIDERS_UPDATED_EVENT = 'spearcode-providers-updated'

export function SettingsPanel() {
  const [config, setConfig] = useState<any>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [wsInput, setWsInput] = useState('')
  const [fontInput, setFontInput] = useState(14)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Add-provider form state
  const [showAdd, setShowAdd] = useState(false)
  const [addPreset, setAddPreset] = useState(PROVIDER_PRESETS[0].id)
  const [addApiKey, setAddApiKey] = useState('')
  const [addBaseUrl, setAddBaseUrl] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')

  const reloadProviders = useCallback(async () => {
    const p = await apiFetch<{ providers: ProviderInfo[] }>('/providers')
    if (p) setProviders(p.providers)
  }, [])

  useEffect(() => {
    apiFetch<any>('/config').then(c => { if (c) { setConfig(c); setWsInput(c.workspace || ''); setFontInput(c.font_size || 14) } })
    reloadProviders()
  }, [reloadProviders])

  const save = async () => {
    setSaving(true)
    await apiFetch('/config', { method: 'PUT', body: JSON.stringify({ workspace: wsInput || undefined, font_size: fontInput }) })
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const submitAddProvider = async () => {
    setAddError('')
    const preset = PROVIDER_PRESETS.find(p => p.id === addPreset)!
    const name = preset.id
    if (!addApiKey.trim() && preset.id !== 'ollama') { setAddError('Cle API requise'); return }
    setAddBusy(true)
    try {
      const body: any = { api_key: addApiKey.trim() || 'local', enabled: true }
      if (addBaseUrl.trim()) body.base_url = addBaseUrl.trim()
      const res = await fetch(`/api/config/user/providers/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        setAddError(`Erreur ${res.status}: ${msg.slice(0, 200)}`)
        return
      }
      setAddApiKey(''); setAddBaseUrl(''); setShowAdd(false)
      await reloadProviders()
      window.dispatchEvent(new CustomEvent(PROVIDERS_UPDATED_EVENT))
    } finally {
      setAddBusy(false)
    }
  }

  const removeProvider = async (name: string) => {
    if (!confirm(`Supprimer la cle ${name} ?`)) return
    await fetch(`/api/config/user/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await reloadProviders()
    window.dispatchEvent(new CustomEvent(PROVIDERS_UPDATED_EVENT))
  }

  const currentPreset = PROVIDER_PRESETS.find(p => p.id === addPreset)!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div style={{ ...S.sl, paddingTop: 12 }}>Parametres SpearCode</div>
      <div style={{ padding: '6px 12px' }}>
        <label style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }}>Workspace</label>
        <input value={wsInput} onChange={e => setWsInput(e.target.value)} placeholder="data/workspace" style={{ width: '100%', padding: '5px 10px', fontSize: 11, borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>
      <div style={{ padding: '6px 12px' }}>
        <label style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }}>Police ({fontInput}px)</label>
        <input type="range" min={8} max={24} value={fontInput} onChange={e => setFontInput(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--scarlet)' }} />
      </div>
      <div style={{ padding: '4px 12px 10px' }}>
        <button onClick={save} disabled={saving} style={{ width: '100%', padding: '5px 0', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, cursor: 'pointer', background: saved ? '#22c55e' : 'var(--scarlet)', color: '#fff', transition: 'background 0.3s' }}>
          {saving ? 'Sauvegarde...' : saved ? 'OK !' : 'Sauvegarder'}
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--border)' }}>
        <div style={{ ...S.sl, paddingTop: 10 }}>Providers IA</div>

        <div style={{ padding: '0 12px 8px' }}>
          <button type="button" onClick={() => setShowAdd(s => !s)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, border: 'none', cursor: 'pointer', background: showAdd ? 'var(--bg-tertiary)' : 'var(--scarlet)', color: showAdd ? 'var(--text-primary)' : '#fff', borderRadius: 6, padding: '8px 12px', fontSize: 11, fontWeight: 700, letterSpacing: 0.3, transition: 'background 0.15s' }}>
            {showAdd
              ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Annuler</>
              : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Ajouter un provider</>
            }
          </button>
        </div>

        {showAdd && (
          <div style={{ padding: '6px 12px 10px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 9, color: 'var(--text-muted)' }}>Provider</label>
            <select value={addPreset} onChange={e => setAddPreset(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }}>
              {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {currentPreset.hint && <span style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.8 }}>{currentPreset.hint}</span>}

            <input type="password" value={addApiKey} onChange={e => setAddApiKey(e.target.value)}
              placeholder={addPreset === 'ollama' ? 'Laisse vide (local)' : 'sk-...'}
              autoComplete="new-password"
              style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />

            {currentPreset.baseUrlPlaceholder && (
              <input value={addBaseUrl} onChange={e => setAddBaseUrl(e.target.value)} placeholder={currentPreset.baseUrlPlaceholder}
                style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />
            )}

            {addError && <span style={{ fontSize: 10, color: '#f87171' }}>{addError}</span>}

            <button onClick={submitAddProvider} disabled={addBusy}
              style={{ marginTop: 2, padding: '5px 0', borderRadius: 4, border: 'none', fontSize: 10, fontWeight: 700, cursor: addBusy ? 'wait' : 'pointer', background: 'var(--scarlet)', color: '#fff' }}>
              {addBusy ? 'Enregistrement...' : 'Enregistrer la cle'}
            </button>
          </div>
        )}

        {providers.length === 0
          ? <div style={{ padding: '6px 12px', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Aucun provider configure. Clique sur <b>+ Ajouter</b> pour brancher OpenRouter, Anthropic, OpenAI, etc.
            </div>
          : providers.map(p => {
            const ok = p.registered !== false && p.enabled !== false
            return (
              <div key={p.name} style={{ padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--border)' }}>
                <span title={ok ? 'Actif' : 'Non supporté par ce backend'} style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? '#22c55e' : '#f59e0b' }} />
                <span style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600, flex: 1 }}>{p.name}</span>
                {p.default_model && <span style={{ ...S.badge('#3b82f6', true), fontSize: 8 }}>{p.default_model}</span>}
                {p.models?.length > 0 && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{p.models.length} mod.</span>}
                <button onClick={() => removeProvider(p.name)} title="Supprimer la cle"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#dc2626', opacity: 0.6, padding: '0 3px', fontSize: 11 }}>&times;</button>
              </div>
            )
          })
        }
      </div>
      <GitCredentialsPanel />
      <div style={{ borderTop: '1px solid var(--border)', padding: '0 12px 14px' }}>
        <div style={{ ...S.sl, padding: '10px 0 6px' }}>Raccourcis</div>
        {[['Ctrl+K', 'Command palette'], ['Ctrl+S', 'Sauvegarder'], ['Ctrl+H', 'Chercher/Remplacer'], ['Ctrl+D', 'Diff'], ['Ctrl+Shift+T', 'Terminal'], ['Ctrl+Shift+P', 'Apercu Markdown']].map(([k, d]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <kbd style={{ padding: '0 5px', background: 'var(--bg-tertiary)', borderRadius: 3, fontSize: 9, border: '1px solid var(--border)', fontFamily: MONO, minWidth: 55, textAlign: 'center', color: 'var(--text-primary)' }}>{k}</kbd>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
