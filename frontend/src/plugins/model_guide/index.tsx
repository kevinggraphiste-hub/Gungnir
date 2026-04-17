/**
 * Gungnir Plugin — Model Guide v3
 *
 * Catalog with live pricing, aligned spreadsheet layout,
 * filters by price/features, quick picks, descriptions.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { PageHeader, SecondaryButton } from '@core/components/ui'
import { Layers, RefreshCw, Search as SearchIcon } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelInfo {
  id: string
  name: string
  provider: string
  description: string
  context_window: number
  pricing: { input: number; output: number; tier: string }
  vision: boolean
}

interface ProviderGroup {
  provider: string
  enabled: boolean
  has_api_key: boolean
  default_model: string | null
  model_count: number
  models: ModelInfo[]
}

interface QuickPick {
  label: string
  model: string
  provider_hint: string
}

interface TierInfo {
  symbol: string
  label: string
  description: string
  color: string
}

// ── API ──────────────────────────────────────────────────────────────────────

const API = '/api/plugins/model_guide'

async function apiFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`)
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

// ── Favorites (shared with Chat) ─────────────────────────────────────────────

const FAV_KEY = 'gungnir_favorite_models'

function getFavorites(): string[] {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]') } catch { return [] }
}

function toggleFavorite(modelId: string): string[] {
  const favs = getFavorites()
  const idx = favs.indexOf(modelId)
  const updated = idx >= 0 ? favs.filter((_, i) => i !== idx) : [...favs, modelId].slice(-5)
  localStorage.setItem(FAV_KEY, JSON.stringify(updated))
  return updated
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtCtx(n: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function fmtPrice(n: number): string {
  if (n === 0) return 'Gratuit'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

// ── Tier config ──────────────────────────────────────────────────────────────

const TIER_CONFIG: Record<string, { symbol: string; label: string; color: string; bg: string }> = {
  free:     { symbol: '∅',    label: 'Gratuit',       color: '#22c55e', bg: 'rgba(34,197,94,.12)' },
  cheap:    { symbol: '¢',    label: 'Quasi-gratuit', color: '#22c55e', bg: 'rgba(34,197,94,.12)' },
  budget:   { symbol: '$',    label: 'Budget',        color: '#3b82f6', bg: 'rgba(59,130,246,.12)' },
  mid:      { symbol: '$$',   label: 'Standard',      color: '#ca8a04', bg: 'rgba(234,179,8,.12)' },
  premium:  { symbol: '$$$',  label: 'Premium',       color: '#dc2626', bg: 'rgba(204,27,27,.12)' },
  flagship: { symbol: '$$$$', label: 'Flagship',      color: '#7c2d12', bg: 'rgba(124,45,18,.15)' },
  unknown:  { symbol: '?',    label: 'Inconnu',       color: '#6b7280', bg: 'rgba(107,114,128,.12)' },
}

// ── Provider display ─────────────────────────────────────────────────────────

const PROVIDER_DISPLAY: Record<string, { name: string; dot: string }> = {
  openrouter:  { name: 'OpenRouter',       dot: '#6366f1' },
  google:      { name: 'Google Gemini',    dot: '#4285f4' },
  anthropic:   { name: 'Anthropic Claude', dot: '#cc1b1b' },
  openai:      { name: 'OpenAI',           dot: '#10b981' },
  minimax:     { name: 'MiniMax',          dot: '#ec4899' },
  ollama:      { name: 'Ollama (Local)',   dot: '#8b5cf6' },
}

const QP_COLORS: Record<string, { bg: string; color: string }> = {
  gemini:     { bg: 'rgba(66,133,244,.15)',  color: '#4285f4' },
  anthropic:  { bg: 'rgba(204,27,27,.12)',   color: '#cc1b1b' },
  deepseek:   { bg: 'rgba(6,182,212,.15)',   color: '#06b6d4' },
  openai:     { bg: 'rgba(16,185,129,.12)',  color: '#10b981' },
  perplexity: { bg: 'rgba(32,182,214,.12)',  color: '#20b6d6' },
  meta:       { bg: 'rgba(59,130,246,.12)',  color: '#3b82f6' },
}

// ── Column widths (aligned spreadsheet) ──────────────────────────────────────

const COL = {
  star: 24,
  name: 0.8,   // flex — reduced to give more space to desc
  desc: 1.5,   // flex — larger to show full descriptions
  ctx: 44,
  vision: 38,
  input: 62,
  output: 62,
  tier: 38,
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function ModelGuidePlugin() {
  const [catalog, setCatalog] = useState<Record<string, ProviderGroup>>({})
  const [quickPicks, setQuickPicks] = useState<QuickPick[]>([])
  const [tiers, setTiers] = useState<Record<string, TierInfo>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [favorites, setFavorites] = useState<string[]>(getFavorites())
  const [filterTier, setFilterTier] = useState<string | null>(null)
  const [filterVision, setFilterVision] = useState(false)
  const [sortBy, setSortBy] = useState<'name' | 'price' | 'context'>('name')

  const loadData = useCallback(async () => {
    setLoading(true)
    const [c, q, t] = await Promise.all([
      apiFetch<Record<string, ProviderGroup>>('/catalog'),
      apiFetch<QuickPick[]>('/quickpicks'),
      apiFetch<Record<string, TierInfo>>('/tiers'),
    ])
    if (c && typeof c === 'object' && !Array.isArray(c)) setCatalog(c)
    if (Array.isArray(q)) setQuickPicks(q)
    if (t && typeof t === 'object') setTiers(t)
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // All models flat (deduplicated)
  const allModels = useMemo(() => {
    const byKey = new Map<string, ModelInfo>()
    Object.values(catalog).forEach(group => {
      if (Array.isArray(group?.models)) {
        for (const m of group.models) {
          const existing = byKey.get(m.id)
          if (!existing || (existing.provider === 'openrouter' && m.provider !== 'openrouter')) {
            byKey.set(m.id, m)
          }
        }
      }
    })
    return Array.from(byKey.values())
  }, [catalog])

  const totalModels = allModels.length

  // Favorites
  const favoriteModels = useMemo(() =>
    allModels.filter(m => favorites.includes(`${m.provider}::${m.id}`) || favorites.includes(m.id))
  , [allModels, favorites])

  // Filtered + sorted per provider
  const filteredCatalog = useMemo(() => {
    const q = search.toLowerCase()
    const result: Record<string, ProviderGroup> = {}

    for (const [key, group] of Object.entries(catalog)) {
      let models = group.models || []

      if (search) {
        models = models.filter(m =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          (m.description || '').toLowerCase().includes(q)
        )
      }
      if (filterTier) {
        models = models.filter(m => m.pricing.tier === filterTier)
      }
      if (filterVision) {
        models = models.filter(m => m.vision)
      }

      // Sort
      if (sortBy === 'price') {
        models = [...models].sort((a, b) => (a.pricing.input + a.pricing.output) - (b.pricing.input + b.pricing.output))
      } else if (sortBy === 'context') {
        models = [...models].sort((a, b) => b.context_window - a.context_window)
      } else {
        models = [...models].sort((a, b) => a.name.localeCompare(b.name))
      }

      if (models.length > 0) {
        result[key] = { ...group, models, model_count: models.length }
      }
    }
    return result
  }, [catalog, search, filterTier, filterVision, sortBy])

  const filteredTotal = useMemo(() =>
    Object.values(filteredCatalog).reduce((s, g) => s + g.model_count, 0)
  , [filteredCatalog])

  const handleToggleFav = (modelId: string) => setFavorites(toggleFavorite(modelId))

  const hasActiveFilter = search || filterTier || filterVision

  // ── Styles ─────────────────────────────────────────────────────────────

  const filterBtn = (active: boolean, color?: string): React.CSSProperties => ({
    padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
    border: 'none', cursor: 'pointer',
    background: active ? (color || 'var(--scarlet)') : 'var(--bg-tertiary)',
    color: active ? '#fff' : 'var(--text-muted)',
    transition: 'all 0.15s',
  })

  // ── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-muted)' }}>
        Chargement du catalogue...
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 0' }}>
        <PageHeader
          icon={<Layers size={18} />}
          title="Guide des Modèles"
          subtitle={`${totalModels} modèle${totalModels > 1 ? 's' : ''} disponible${totalModels > 1 ? 's' : ''}`}
          actions={(
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--bg-secondary)', borderRadius: 8, padding: '6px 12px',
                border: '1px solid var(--border-subtle)', minWidth: 220,
              }}>
                <SearchIcon size={13} color="var(--text-muted)" />
                <input
                  type="text" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Rechercher..."
                  style={{
                    background: 'transparent', border: 'none', outline: 'none', flex: 1,
                    color: 'var(--text-primary)', fontSize: 12,
                  }}
                />
                {search && (
                  <button onClick={() => setSearch('')} style={{
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0,
                  }}>×</button>
                )}
              </div>
              <SecondaryButton size="sm" icon={<RefreshCw size={12} />} onClick={loadData} title="Rafraichir">
                Rafraichir
              </SecondaryButton>
            </>
          )}
        />
      </div>

      {/* Filters bar */}
      <div style={{
        padding: '8px 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', display: 'flex', gap: 16, alignItems: 'center',
        flexWrap: 'wrap', flexShrink: 0,
      }}>
        {/* Price tier filters */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginRight: 4 }}>PRIX</span>
          {Object.entries(TIER_CONFIG).filter(([k]) => k !== 'unknown').map(([key, t]) => (
            <button key={key} onClick={() => setFilterTier(filterTier === key ? null : key)}
              style={filterBtn(filterTier === key, t.color)}>
              {t.symbol}
            </button>
          ))}
        </div>

        {/* Feature filters */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginRight: 4 }}>FILTRES</span>
          <button onClick={() => setFilterVision(!filterVision)}
            style={filterBtn(filterVision, '#14b8a6')}>
            Vision
          </button>
        </div>

        {/* Sort */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginRight: 4 }}>TRI</span>
          <button onClick={() => setSortBy('name')} style={filterBtn(sortBy === 'name')}>A-Z</button>
          <button onClick={() => setSortBy('price')} style={filterBtn(sortBy === 'price')}>Prix ↑</button>
          <button onClick={() => setSortBy('context')} style={filterBtn(sortBy === 'context')}>Contexte ↓</button>
        </div>

        {/* Active filter count */}
        {hasActiveFilter && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {filteredTotal} resultat{filteredTotal > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px' }}>

        {/* Quick picks (hidden when filtering) */}
        {!hasActiveFilter && quickPicks.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
              Choix rapide
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 6 }}>
              {quickPicks.map(qp => {
                const qpStyle = QP_COLORS[qp.provider_hint] || { bg: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }
                return (
                  <div key={qp.model} onClick={() => setSearch(qp.model.split('/').pop() || '')}
                    style={{
                      padding: '8px 12px', borderRadius: 8,
                      background: 'var(--bg-card)', border: '1px solid var(--border)',
                      cursor: 'pointer', transition: 'border-color 0.15s',
                    }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3 }}>{qp.label}</div>
                    <div style={{
                      fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                      display: 'inline-block', background: qpStyle.bg, color: qpStyle.color,
                    }}>
                      {qp.model.split('/').pop()}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Favorites */}
        {!hasActiveFilter && favoriteModels.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
              fontSize: 10, fontWeight: 700, color: 'var(--scarlet)', textTransform: 'uppercase', letterSpacing: 1,
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--scarlet)" stroke="none">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              Favoris
            </div>
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <HeaderRow />
              {favoriteModels.map((m, i) => (
                <ModelRow key={`fav-${m.id}-${i}`} model={m} isFav onToggleFav={handleToggleFav} />
              ))}
            </div>
          </div>
        )}

        {/* Tier legend (compact) */}
        {!hasActiveFilter && (
          <div style={{
            display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center',
            padding: '6px 12px', background: 'var(--bg-card)', borderRadius: 8,
            border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>Echelle prix :</span>
            {Object.entries(TIER_CONFIG).filter(([k]) => k !== 'unknown').map(([key, t]) => (
              <span key={key} style={{
                fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                background: t.bg, color: t.color,
              }}>
                {t.symbol} {t.label}
              </span>
            ))}
          </div>
        )}

        {/* Provider sections */}
        {Object.entries(filteredCatalog)
          .sort(([a], [b]) => {
            const order: Record<string, number> = { google: 0, anthropic: 1, openai: 2, deepseek: 3, minimax: 4, ollama: 90, openrouter: 99 }
            return (order[a] ?? 50) - (order[b] ?? 50)
          })
          .map(([providerKey, group]) => {
            const prov = PROVIDER_DISPLAY[providerKey] || { name: providerKey, dot: '#6b7280' }
            return (
              <div key={providerKey} style={{ marginBottom: 20 }}>
                {/* Section header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '4px 0',
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: prov.dot, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{prov.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {group.model_count} modele{group.model_count > 1 ? 's' : ''}
                  </span>
                  {!group.has_api_key && (
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: 'rgba(234,179,8,.15)', color: '#ca8a04', fontWeight: 600,
                    }}>Pas de cle API</span>
                  )}
                </div>

                {/* Table */}
                <div style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border)',
                  borderRadius: 10, overflow: 'hidden',
                }}>
                  <HeaderRow />
                  {group.models.map((m, i) => (
                    <ModelRow
                      key={`${m.id}-${i}`}
                      model={m}
                      isFav={favorites.includes(`${m.provider}::${m.id}`) || favorites.includes(m.id)}
                      onToggleFav={handleToggleFav}
                    />
                  ))}
                </div>
              </div>
            )
          })}

        {Object.keys(filteredCatalog).length === 0 && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)', fontSize: 14 }}>
            Aucun modele ne correspond aux filtres
          </div>
        )}
      </div>
    </div>
  )
}

// ── Header Row (column labels) ───────────────────────────────────────────────

function HeaderRow() {
  const hStyle: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: 0.5,
    padding: '6px 0',
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      padding: '0 16px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-secondary)',
    }}>
      <div style={{ width: COL.star }} />
      <div style={{ flex: 0.8, minWidth: 0, ...hStyle }}>Modele</div>
      <div style={{ flex: 1.5, minWidth: 0, ...hStyle }}>Description</div>
      <div style={{ width: COL.ctx, ...hStyle, textAlign: 'center' }}>Ctx</div>
      <div style={{ width: COL.vision, ...hStyle, textAlign: 'center' }}>Vis.</div>
      <div style={{ width: COL.input, ...hStyle, textAlign: 'right' }}>In /1M</div>
      <div style={{ width: COL.output, ...hStyle, textAlign: 'right' }}>Out /1M</div>
      <div style={{ width: COL.tier, ...hStyle, textAlign: 'center' }}>Prix</div>
    </div>
  )
}

// ── Model Row (aligned columns) ──────────────────────────────────────────────

function ModelRow({ model, isFav, onToggleFav }: {
  model: ModelInfo; isFav: boolean; onToggleFav: (id: string) => void
}) {
  const tier = TIER_CONFIG[model.pricing.tier] || TIER_CONFIG.unknown

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '7px 16px', borderBottom: '1px solid var(--border-subtle)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.03))')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Star */}
      <div style={{ width: COL.star, flexShrink: 0 }}>
        <button onClick={() => onToggleFav(model.id)} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 2,
        }} title={isFav ? 'Retirer des favoris' : 'Ajouter aux favoris (max 5)'}>
          <svg width="13" height="13" viewBox="0 0 24 24"
            fill={isFav ? 'var(--scarlet)' : 'none'}
            stroke={isFav ? 'var(--scarlet)' : 'var(--text-muted)'}
            strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
      </div>

      {/* Model name */}
      <div style={{
        flex: 0.8, minWidth: 0, overflow: 'hidden',
        fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
        whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        paddingRight: 6,
      }}>
        {model.name}
      </div>

      {/* Description */}
      <div style={{
        flex: 1.5, minWidth: 0, overflow: 'hidden',
        fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic',
        whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        paddingRight: 6,
      }}>
        {model.description || '—'}
      </div>

      {/* Context */}
      <div style={{
        width: COL.ctx, flexShrink: 0, textAlign: 'center',
        fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
        color: 'var(--text-secondary)',
      }}>
        {fmtCtx(model.context_window)}
      </div>

      {/* Vision */}
      <div style={{ width: COL.vision, flexShrink: 0, textAlign: 'center', fontSize: 11 }}>
        {model.vision
          ? <span style={{ color: '#14b8a6', fontWeight: 600 }}>✓</span>
          : <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>—</span>
        }
      </div>

      {/* Input price */}
      <div style={{
        width: COL.input, flexShrink: 0, textAlign: 'right',
        fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
        color: model.pricing.input === 0 ? '#22c55e' : 'var(--text-secondary)',
      }}>
        {fmtPrice(model.pricing.input)}
      </div>

      {/* Output price */}
      <div style={{
        width: COL.output, flexShrink: 0, textAlign: 'right',
        fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
        color: model.pricing.output === 0 ? '#22c55e' : 'var(--text-secondary)',
      }}>
        {fmtPrice(model.pricing.output)}
      </div>

      {/* Tier badge */}
      <div style={{ width: COL.tier, flexShrink: 0, textAlign: 'center' }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: tier.bg, color: tier.color,
        }}>
          {tier.symbol}
        </span>
      </div>
    </div>
  )
}
