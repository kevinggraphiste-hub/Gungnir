import { useState, useEffect, useCallback } from 'react'
import type { ProviderInfo } from '../types'
import { apiFetch, MONO } from '../utils'
import { GitCredentialsPanel } from './GitPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL — style page principal Gungnir (sections aérées + cards)
// ═══════════════════════════════════════════════════════════════════════════════

const PROVIDER_PRESETS: { id: string; label: string; hint: string; baseUrlPlaceholder?: string }[] = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'Claude + GPT + 200 modèles via clé unique' },
  { id: 'anthropic', label: 'Anthropic (Claude API)', hint: 'console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', hint: 'platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Gemini', hint: 'aistudio.google.com/apikey' },
  { id: 'mistral', label: 'Mistral', hint: 'console.mistral.ai/api-keys' },
  { id: 'xai', label: 'xAI (Grok)', hint: 'console.x.ai' },
  { id: 'minimax', label: 'MiniMax', hint: 'api.minimax.chat' },
  { id: 'ollama', label: 'Ollama (local)', hint: 'base URL http://localhost:11434', baseUrlPlaceholder: 'http://localhost:11434' },
]

export const PROVIDERS_UPDATED_EVENT = 'spearcode-providers-updated'

const SHORTCUTS: [string, string][] = [
  ['Ctrl+K', 'Command palette'],
  ['Ctrl+S', 'Sauvegarder'],
  ['Ctrl+H', 'Chercher/Remplacer'],
  ['Ctrl+D', 'Diff'],
  ['Ctrl+Shift+T', 'Terminal'],
  ['Ctrl+Shift+P', 'Aperçu Markdown'],
  ['Ctrl+L', 'Assistant IA'],
  ['Ctrl+Shift+S', 'Snippets'],
]

// Sections principales — même pattern que frontend/src/core/pages/Settings.tsx.
function Section({ title, description, children }: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border p-6"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)' }}>
      <h3 className="font-semibold mb-1" style={{ color: 'var(--text-primary)', fontSize: 16 }}>{title}</h3>
      {description && (
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{description}</p>
      )}
      <div className="space-y-3">{children}</div>
    </div>
  )
}

// Toggle "Format on save" — applique black/prettier/gofmt/rustfmt avant
// chaque Ctrl+S. Désactivé par défaut ; valeur persistée dans localStorage
// et lue par CodeEditor au moment du save.
function FormatOnSaveToggle() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('spearcode_format_on_save') === 'true' } catch { return false }
  })
  const [available, setAvailable] = useState<Record<string, boolean> | null>(null)

  useEffect(() => {
    apiFetch<{ formatters: Record<string, boolean> }>('/format/available').then(r => {
      if (r) setAvailable(r.formatters)
    })
  }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    try { localStorage.setItem('spearcode_format_on_save', String(next)) } catch { /* ignore */ }
  }

  const installedCount = available ? Object.values(available).filter(Boolean).length : 0
  const totalCount = available ? Object.keys(available).length : 0

  return (
    <div className="flex items-center gap-4 pt-2">
      <label className="text-sm font-medium" style={{ color: 'var(--text-primary)', minWidth: 140 }}>
        Format on save
      </label>
      <button onClick={toggle}
        className="rounded-full transition-colors"
        style={{
          width: 42, height: 22, position: 'relative', border: 'none', cursor: 'pointer',
          background: enabled ? 'var(--scarlet)' : 'var(--bg-tertiary)',
        }}>
        <span style={{
          position: 'absolute', top: 2, left: enabled ? 22 : 2,
          width: 18, height: 18, borderRadius: '50%',
          background: '#fff', transition: 'left 0.15s',
        }} />
      </button>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {enabled ? 'Actif' : 'Désactivé'}
        {available != null && ` — ${installedCount}/${totalCount} formatters installés`}
      </span>
    </div>
  )
}

// Éditeur du fichier `.spearcode` à la racine du workspace — règles que
// l'agent SpearCode consulte à chaque chat (ton, conventions, interdits…).
// Plus visible ici que dans un fichier caché que personne ne pense à créer.
function ProjectRulesSection() {
  const [content, setContent] = useState('')
  const [exists, setExists] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    apiFetch<{ ok: boolean; content: string; exists: boolean }>('/project-rules').then(r => {
      if (r) { setContent(r.content || ''); setExists(!!r.exists) }
      setLoaded(true)
    })
  }, [])

  const save = async () => {
    setSaving(true)
    const r = await apiFetch<{ ok: boolean }>('/project-rules', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    })
    setSaving(false)
    if (r?.ok) { setExists(true); setSaved(true); setTimeout(() => setSaved(false), 2000) }
  }

  return (
    <Section
      title="Règles projet (.spearcode)"
      description="Fichier texte à la racine du workspace. L'assistant SpearCode le lit à chaque conversation pour adapter son ton, les conventions de code à suivre, les interdits (ex: 'pas de any en TS', 'commentaires en français', etc.)."
    >
      {!loaded ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Chargement…</div>
      ) : (
        <>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Statut : {exists
              ? <span style={{ color: '#22c55e' }}>actif</span>
              : <span style={{ color: '#f59e0b' }}>pas encore créé — écris dans la zone ci-dessous et sauvegarde</span>}
          </div>
          <textarea
            value={content} onChange={e => setContent(e.target.value)}
            placeholder={`Exemple :
- Réponds toujours en français.
- Privilégie TypeScript strict (pas de any).
- Pour les commits, format "type(scope): message".
- Ne modifie jamais le dossier backend/core/db/ sans demander.`}
            rows={10}
            className="w-full rounded-lg border px-4 py-3 focus:outline-none"
            style={{
              background: 'var(--bg-primary)', borderColor: 'var(--border)',
              color: 'var(--text-primary)', fontFamily: MONO, fontSize: 12,
              resize: 'vertical',
            }}
          />
          <button onClick={save} disabled={saving}
            className="rounded-lg px-5 py-2 text-sm font-semibold transition-colors"
            style={{
              background: saved ? 'var(--accent-success, #22c55e)' : 'var(--scarlet)',
              color: '#fff', border: 'none', cursor: saving ? 'wait' : 'pointer',
            }}>
            {saving ? 'Sauvegarde…' : saved ? '✓ Sauvegardé' : 'Sauvegarder les règles'}
          </button>
        </>
      )}
    </Section>
  )
}

export function SettingsPanel({ uiFontSize, setUiFontSize }: {
  uiFontSize?: number
  setUiFontSize?: (n: number) => void
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [wsInput, setWsInput] = useState('')
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
    apiFetch<any>('/config').then(c => { if (c) setWsInput(c.workspace || '') })
    reloadProviders()
  }, [reloadProviders])

  const save = async () => {
    setSaving(true)
    // Persist workspace au backend ; la font-size UI reste locale (CSS var + localStorage).
    await apiFetch('/config', {
      method: 'PUT',
      body: JSON.stringify({ workspace: wsInput || undefined }),
    })
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const submitAddProvider = async () => {
    setAddError('')
    const preset = PROVIDER_PRESETS.find(p => p.id === addPreset)!
    if (!addApiKey.trim() && preset.id !== 'ollama') { setAddError('Clé API requise'); return }
    setAddBusy(true)
    try {
      const body: any = { api_key: addApiKey.trim() || 'local', enabled: true }
      if (addBaseUrl.trim()) body.base_url = addBaseUrl.trim()
      const res = await fetch(`/api/config/user/providers/${encodeURIComponent(preset.id)}`, {
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
    if (!confirm(`Supprimer la clé ${name} ?`)) return
    await fetch(`/api/config/user/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await reloadProviders()
    window.dispatchEvent(new CustomEvent(PROVIDERS_UPDATED_EVENT))
  }

  const currentPreset = PROVIDER_PRESETS.find(p => p.id === addPreset)!

  // Fallback si le parent n'a pas passé les props (rendu standalone) :
  // on gère la font-size localement via localStorage + CSS var globale.
  const [localFont, setLocalFont] = useState<number>(() => {
    if (uiFontSize) return uiFontSize
    try {
      const v = Number(localStorage.getItem('spearcode_font_size') || '')
      return Number.isFinite(v) && v >= 11 && v <= 18 ? v : 13
    } catch { return 13 }
  })
  const fontVal = uiFontSize ?? localFont
  const applyFont = (n: number) => {
    if (setUiFontSize) setUiFontSize(n)
    else {
      setLocalFont(n)
      try { localStorage.setItem('spearcode_font_size', String(n)) } catch { /* ignore */ }
    }
  }

  return (
    <div className="p-6 space-y-6" style={{ maxWidth: 1100, margin: '0 auto' }}>

      {/* ── Apparence ─────────────────────────────────────────────────────── */}
      <Section
        title="Apparence & édition"
        description="Réglages visuels et comportement de l'éditeur. La taille de police affecte les textes de l'UI SpearCode (bulles chat, badges, listes)."
      >
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium" style={{ color: 'var(--text-primary)', minWidth: 140 }}>
            Taille de police UI
          </label>
          <input
            type="range" min={11} max={18} step={1}
            value={fontVal} onChange={e => applyFont(Number(e.target.value))}
            className="flex-1" style={{ accentColor: 'var(--scarlet)', maxWidth: 400 }}
          />
          <span className="text-sm"
            style={{ color: 'var(--text-primary)', fontFamily: MONO, minWidth: 56, textAlign: 'right' }}>
            {fontVal} px
          </span>
        </div>
        <FormatOnSaveToggle />
      </Section>

      {/* ── Workspace ─────────────────────────────────────────────────────── */}
      <Section
        title="Workspace"
        description="Dossier racine où SpearCode lit et écrit tes fichiers. Chaque utilisateur a son propre workspace isolé par défaut."
      >
        <input
          value={wsInput} onChange={e => setWsInput(e.target.value)}
          placeholder="data/workspace"
          className="w-full rounded-lg border px-4 py-3 focus:outline-none"
          style={{
            background: 'var(--bg-primary)', borderColor: 'var(--border)',
            color: 'var(--text-primary)', fontFamily: MONO, fontSize: 13,
          }}
        />
        <button onClick={save} disabled={saving}
          className="rounded-lg px-5 py-2 text-sm font-semibold transition-colors"
          style={{
            background: saved ? 'var(--accent-success, #22c55e)' : 'var(--scarlet)',
            color: '#fff', border: 'none', cursor: saving ? 'wait' : 'pointer',
          }}>
          {saving ? 'Sauvegarde…' : saved ? '✓ Sauvegardé' : 'Sauvegarder'}
        </button>
      </Section>

      {/* ── Providers IA ─────────────────────────────────────────────────── */}
      <Section
        title="Providers IA"
        description="Clés API pour les modèles utilisés par le panneau assistant SpearCode. Indépendant des providers du chat principal."
      >
        {providers.length === 0 ? (
          <div className="text-sm py-3" style={{ color: 'var(--text-muted)' }}>
            Aucun provider configuré. Clique sur <strong>Ajouter un provider</strong> pour brancher OpenRouter, Anthropic, OpenAI, etc.
          </div>
        ) : (
          <div className="space-y-2">
            {providers.map(p => {
              const ok = p.registered !== false && p.enabled !== false
              return (
                <div key={p.name}
                  className="flex items-center gap-3 rounded-lg border px-4 py-3"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
                  <span title={ok ? 'Actif' : 'Non supporté par ce backend'}
                    style={{ width: 10, height: 10, borderRadius: '50%', background: ok ? '#22c55e' : '#f59e0b', flexShrink: 0 }} />
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                  {p.default_model && (
                    <span className="rounded px-2 py-0.5 text-xs"
                      style={{ background: 'color-mix(in srgb, #3b82f6 12%, transparent)', color: '#3b82f6' }}>
                      {p.default_model}
                    </span>
                  )}
                  {p.models && p.models.length > 0 && (
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{p.models.length} modèle{p.models.length > 1 ? 's' : ''}</span>
                  )}
                  <div className="flex-1" />
                  <button onClick={() => removeProvider(p.name)} title="Supprimer la clé"
                    className="rounded px-2 py-1 text-xs"
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: '#dc2626', cursor: 'pointer' }}>
                    Retirer
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <button type="button" onClick={() => setShowAdd(s => !s)}
          className="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
          style={{
            background: showAdd ? 'var(--bg-tertiary)' : 'var(--scarlet)',
            color: showAdd ? 'var(--text-primary)' : '#fff',
            border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          {showAdd ? 'Annuler' : '+ Ajouter un provider'}
        </button>

        {showAdd && (
          <div className="rounded-lg border p-4 space-y-3"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border)' }}>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Provider</label>
              <select value={addPreset} onChange={e => setAddPreset(e.target.value)}
                className="w-full rounded border px-3 py-2"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
                {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {currentPreset.hint && (
                <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{currentPreset.hint}</div>
              )}
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Clé API</label>
              <input type="password" value={addApiKey} onChange={e => setAddApiKey(e.target.value)}
                placeholder={addPreset === 'ollama' ? 'Laisse vide (local)' : 'sk-…'}
                autoComplete="new-password"
                className="w-full rounded border px-3 py-2"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-primary)', fontFamily: MONO }} />
            </div>
            {currentPreset.baseUrlPlaceholder && (
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>Base URL</label>
                <input value={addBaseUrl} onChange={e => setAddBaseUrl(e.target.value)}
                  placeholder={currentPreset.baseUrlPlaceholder}
                  className="w-full rounded border px-3 py-2"
                  style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border)', color: 'var(--text-primary)', fontFamily: MONO }} />
              </div>
            )}
            {addError && <div className="text-xs" style={{ color: '#f87171' }}>{addError}</div>}
            <button onClick={submitAddProvider} disabled={addBusy}
              className="rounded px-4 py-2 text-sm font-semibold"
              style={{ background: 'var(--scarlet)', color: '#fff', border: 'none', cursor: addBusy ? 'wait' : 'pointer' }}>
              {addBusy ? 'Enregistrement…' : 'Enregistrer la clé'}
            </button>
          </div>
        )}
      </Section>

      {/* ── Git credentials ───────────────────────────────────────────────── */}
      <Section
        title="Identifiants Git"
        description="PAT (personal access token) utilisé par SpearCode pour les opérations git authentifiées (clone, push…)."
      >
        <GitCredentialsPanel />
      </Section>

      {/* ── Règles projet .spearcode ──────────────────────────────────────── */}
      <ProjectRulesSection />

      {/* ── Raccourcis ────────────────────────────────────────────────────── */}
      <Section
        title="Raccourcis clavier"
        description="Actifs quand l'éditeur SpearCode est focus."
      >
        <div className="grid grid-cols-2 gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center gap-3">
              <kbd className="rounded border px-2 py-1 text-xs"
                style={{
                  background: 'var(--bg-primary)', borderColor: 'var(--border)',
                  color: 'var(--text-primary)', fontFamily: MONO, minWidth: 92, textAlign: 'center',
                }}>{k}</kbd>
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{d}</span>
            </div>
          ))}
        </div>
      </Section>

    </div>
  )
}
