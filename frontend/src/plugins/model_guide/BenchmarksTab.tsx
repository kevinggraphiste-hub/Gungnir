/**
 * Benchmarks tab — même principe que le catalogue (fetch dynamique, cache en
 * mémoire via useState, bouton Rafraîchir, tri/filtres côté client).
 *
 * Les scores viennent d'un snapshot curé côté backend (benchmarks_static.json)
 * enrichi avec le pricing live d'OpenRouter. Aucune source benchmark gratuite
 * n'expose d'API publique en 2026 (LMArena/ArtificialAnalysis → 401), d'où ce
 * choix : on affiche les liens officiels en haut pour que l'utilisateur puisse
 * cross-check les valeurs live si besoin.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ExternalLink, Search as SearchIcon } from 'lucide-react'
import { SecondaryButton } from '@core/components/ui'

// ── Types ────────────────────────────────────────────────────────────────────

export interface BenchmarkSource {
  id: string
  name: string
  url: string
  description: string
  metric: string
  live?: boolean
}

export interface BenchmarkRow {
  id: string
  name: string
  provider: string
  context_window: number | null
  input_1m: number | null
  output_1m: number | null
  avg_price: number | null
  price_tier: string
  efficiency: number | null
  // Métriques dynamiques (extraites via `metrics`)
  [key: string]: unknown
}

interface BenchmarksPayload {
  schema_version: number
  last_updated: string | null
  notes: string | null
  metrics: string[]
  models: BenchmarkRow[]
  has_user_filter?: boolean
  aider_models_count?: number
}

interface SourcesPayload {
  last_updated: string | null
  sources: BenchmarkSource[]
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

// ── Styles / constantes ──────────────────────────────────────────────────────

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: '#cc1b1b',
  openai: '#10b981',
  google: '#4285f4',
  deepseek: '#06b6d4',
  'meta-llama': '#3b82f6',
  mistralai: '#f97316',
  'x-ai': '#8b5cf6',
  qwen: '#ec4899',
  microsoft: '#22c55e',
}

const METRIC_LABEL: Record<string, string> = {
  lmarena_elo: 'Elo Arena',
  aa_index: 'AA Index',
  mmlu_pro: 'MMLU-Pro',
  gpqa: 'GPQA',
  livecodebench: 'LiveCode',
  aider_edit_pass2: 'Aider Edit',
  aider_polyglot_pass2: 'Aider Poly',
}

const METRIC_UNIT: Record<string, string> = {
  lmarena_elo: '',
  aa_index: '',
  mmlu_pro: '%',
  gpqa: '%',
  livecodebench: '%',
  aider_edit_pass2: '%',
  aider_polyglot_pass2: '%',
}

function fmtMetric(v: unknown, metric: string): string {
  if (v == null) return '—'
  const n = Number(v)
  if (Number.isNaN(n)) return '—'
  const unit = METRIC_UNIT[metric] || ''
  if (metric === 'lmarena_elo') return String(Math.round(n))
  return `${n.toFixed(1)}${unit}`
}

function fmtPrice(n: number | null): string {
  if (n == null) return '—'
  if (n === 0) return 'Gratuit'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

function fmtCtx(n: number | null): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

// ── Favorites (shared with ModelGuide) ───────────────────────────────────────

const FAV_KEY = 'gungnir_favorite_models'

function getFavorites(): string[] {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]') } catch { return [] }
}

// ── Composant ────────────────────────────────────────────────────────────────

export function BenchmarksTab() {
  const [data, setData] = useState<BenchmarksPayload | null>(null)
  const [sources, setSources] = useState<SourcesPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  const [sortMetric, setSortMetric] = useState<string>('lmarena_elo')
  const [favOnly, setFavOnly] = useState(false)
  const [favorites] = useState<string[]>(getFavorites())

  const load = useCallback(async () => {
    setLoading(true)
    const [b, s] = await Promise.all([
      apiFetch<BenchmarksPayload>('/benchmarks'),
      apiFetch<SourcesPayload>('/benchmarks/sources'),
    ])
    if (b) setData(b)
    if (s) setSources(s)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const providers = useMemo(() => {
    if (!data) return [] as string[]
    return Array.from(new Set(data.models.map(m => m.provider))).sort()
  }, [data])

  const rows = useMemo(() => {
    if (!data) return [] as BenchmarkRow[]
    let r = data.models
    if (search) {
      const q = search.toLowerCase()
      r = r.filter(m => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    }
    if (providerFilter) r = r.filter(m => m.provider === providerFilter)
    if (favOnly) r = r.filter(m => favorites.includes(m.id) || favorites.includes(`${m.provider}::${m.id}`))
    // Tri desc sur la métrique choisie (null → bas du classement)
    r = [...r].sort((a, b) => {
      const va = a[sortMetric]
      const vb = b[sortMetric]
      const na = va == null ? -Infinity : Number(va)
      const nb = vb == null ? -Infinity : Number(vb)
      return nb - na
    })
    return r
  }, [data, search, providerFilter, favOnly, sortMetric, favorites])

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-muted)' }}>
        Chargement des benchmarks...
      </div>
    )
  }

  if (!data) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        Impossible de charger les benchmarks. Reessayez.
      </div>
    )
  }

  const metrics = data.metrics || []

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Barre sources + refresh */}
      <div style={{
        padding: '8px 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', display: 'flex', gap: 12, alignItems: 'center',
        flexWrap: 'wrap', flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>SOURCES</span>
        {sources?.sources.map(s => (
          <a key={s.id} href={s.url} target="_blank" rel="noopener noreferrer" title={s.description}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600,
              padding: '3px 8px', borderRadius: 5, textDecoration: 'none',
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              border: `1px solid ${s.live ? '#22c55e55' : 'var(--border-subtle)'}`,
            }}>
            {s.name}
            <span style={{
              fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
              background: s.live ? '#22c55e22' : 'rgba(234,179,8,.15)',
              color: s.live ? '#22c55e' : '#ca8a04',
            }}>
              {s.live ? 'LIVE' : 'SNAP'}
            </span>
            <ExternalLink size={10} />
          </a>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          MAJ {data.last_updated || '?'}
        </span>
        <SecondaryButton size="sm" icon={<RefreshCw size={12} />} onClick={load} title="Rafraichir">
          Rafraichir
        </SecondaryButton>
      </div>

      {/* Bandeau filtrage per-user */}
      <div style={{
        padding: '5px 24px', fontSize: 10, color: 'var(--text-muted)',
        background: data.has_user_filter ? 'rgba(34,197,94,.06)' : 'rgba(234,179,8,.06)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {data.has_user_filter ? (
          <>
            <span style={{ color: '#22c55e', fontWeight: 700 }}>●</span>
            Filtré sur vos providers configurés — {data.models.length} modèle{data.models.length > 1 ? 's' : ''} avec au moins une métrique connue.
            {data.aider_models_count !== undefined && <> Aider live : {data.aider_models_count} modèles indexés.</>}
          </>
        ) : (
          <>
            <span style={{ color: '#ca8a04', fontWeight: 700 }}>●</span>
            Mode découverte — aucun provider configuré pour votre compte. Affichage du snapshot complet.
          </>
        )}
      </div>
      {data.notes && (
        <div style={{
          padding: '5px 24px', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic',
          background: 'rgba(234,179,8,.06)', borderBottom: '1px solid var(--border-subtle)',
        }}>
          ⚠ {data.notes}
        </div>
      )}

      {/* Filtres */}
      <div style={{
        padding: '8px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
      }}>
        {/* Search */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--bg-secondary)', borderRadius: 6, padding: '4px 10px',
          border: '1px solid var(--border-subtle)', minWidth: 180,
        }}>
          <SearchIcon size={12} color="var(--text-muted)" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Rechercher..."
            style={{ background: 'transparent', border: 'none', outline: 'none', flex: 1, color: 'var(--text-primary)', fontSize: 11 }}
          />
          {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>×</button>}
        </div>

        {/* Provider filter */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginRight: 4 }}>PROVIDER</span>
          <button onClick={() => setProviderFilter(null)} style={chipStyle(providerFilter === null)}>Tous</button>
          {providers.map(p => (
            <button key={p} onClick={() => setProviderFilter(providerFilter === p ? null : p)}
              style={chipStyle(providerFilter === p, PROVIDER_COLOR[p])}>
              {p}
            </button>
          ))}
        </div>

        {/* Sort by metric */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, marginRight: 4 }}>TRI</span>
          {metrics.map(m => (
            <button key={m} onClick={() => setSortMetric(m)} style={chipStyle(sortMetric === m)}>
              {METRIC_LABEL[m] || m}
            </button>
          ))}
          <button onClick={() => setSortMetric('efficiency')} style={chipStyle(sortMetric === 'efficiency', '#22c55e')}>
            ⚡ Eff.
          </button>
        </div>

        <button onClick={() => setFavOnly(v => !v)} style={chipStyle(favOnly, '#dc2626')}>
          ★ Favoris
        </button>
      </div>

      {/* Tableau */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 1 }}>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={thStyle('left', 28)}>#</th>
              <th style={thStyle('left')}>Modèle</th>
              <th style={thStyle('center', 90)}>Provider</th>
              {metrics.map(m => (
                <th key={m} style={{ ...thStyle('right', 72), background: sortMetric === m ? 'rgba(220,38,38,.08)' : undefined }}>
                  {METRIC_LABEL[m] || m}
                </th>
              ))}
              <th style={thStyle('right', 70)}>In/1M</th>
              <th style={thStyle('right', 70)}>Out/1M</th>
              <th style={thStyle('right', 72)}>Ctx</th>
              <th style={{ ...thStyle('right', 72), background: sortMetric === 'efficiency' ? 'rgba(34,197,94,.08)' : undefined }}>
                Eff.
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={tdStyle('left')}><span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{i + 1}</span></td>
                <td style={tdStyle('left')}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{m.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{m.id}</div>
                </td>
                <td style={tdStyle('center')}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                    background: `${PROVIDER_COLOR[m.provider] || '#6b7280'}22`,
                    color: PROVIDER_COLOR[m.provider] || 'var(--text-muted)',
                  }}>{m.provider}</span>
                </td>
                {metrics.map(metric => {
                  const v = m[metric] as number | null | undefined
                  return (
                    <td key={metric} style={{ ...tdStyle('right'), fontFamily: 'monospace' }}>
                      {fmtMetric(v, metric)}
                    </td>
                  )
                })}
                <td style={{ ...tdStyle('right'), fontFamily: 'monospace' }}>{fmtPrice(m.input_1m)}</td>
                <td style={{ ...tdStyle('right'), fontFamily: 'monospace' }}>{fmtPrice(m.output_1m)}</td>
                <td style={{ ...tdStyle('right'), fontFamily: 'monospace' }}>{fmtCtx(m.context_window)}</td>
                <td style={{ ...tdStyle('right'), fontFamily: 'monospace', color: m.efficiency != null ? '#22c55e' : 'var(--text-muted)' }}>
                  {m.efficiency != null ? m.efficiency.toFixed(0) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Aucun modèle ne correspond aux filtres.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers styles ───────────────────────────────────────────────────────────

function chipStyle(active: boolean, color?: string): React.CSSProperties {
  return {
    padding: '3px 9px', borderRadius: 5, fontSize: 10, fontWeight: 600,
    border: 'none', cursor: 'pointer',
    background: active ? (color || 'var(--scarlet)') : 'var(--bg-tertiary)',
    color: active ? '#fff' : 'var(--text-muted)',
    transition: 'all 0.15s',
  }
}

function thStyle(align: 'left' | 'right' | 'center', width?: number): React.CSSProperties {
  return {
    padding: '8px 10px', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: 0.5,
    textAlign: align, width,
  }
}

function tdStyle(align: 'left' | 'right' | 'center'): React.CSSProperties {
  return { padding: '7px 10px', textAlign: align, color: 'var(--text-secondary)' }
}
