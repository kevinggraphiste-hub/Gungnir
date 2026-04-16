/**
 * HuntR v3 — Perplexity-like Search for Gungnir
 *
 * Classique (free) : DuckDuckGo → formatted results, no LLM
 * Pro              : Tavily + LLM synthesis with inline [1][2] citations
 *
 * Per-user: each user needs their own Tavily key (free 1000/mo) + LLM provider.
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { useStore } from '@core/stores/appStore'

// ── Types ─────────────────────────────────────────────────────────────────

interface Citation {
  index: number
  url: string
  title: string
  snippet?: string
}

interface SearchResult {
  answer: string
  citations: Citation[]
  related_questions: string[]
  search_count: number
  pro_search: boolean
  topic: Topic
  engines: string[]
  time_ms: number
  model?: string
  error?: boolean
}

type Topic = 'web' | 'news' | 'academic' | 'code'

const TOPICS: { id: Topic; label: string; icon: string; desc: string }[] = [
  { id: 'web',      label: 'Web',        icon: 'globe',    desc: 'Recherche générale' },
  { id: 'news',     label: 'Actu',       icon: 'news',     desc: "Actualités récentes" },
  { id: 'academic', label: 'Académique', icon: 'book',     desc: 'Papiers & recherche' },
  { id: 'code',     label: 'Code',       icon: 'code',     desc: 'Dev, docs, StackOverflow' },
]

const TOPIC_LABELS: Record<Topic, string> = {
  web: 'Web', news: 'Actu', academic: 'Académique', code: 'Code',
}

interface LiveSource {
  title: string
  url: string
  snippet?: string
  source?: string
}

interface HistoryEntry {
  id?: number
  query: string
  mode: string
  topic?: Topic
  sources_count: number
  time_ms: number
  timestamp: number
  answer?: string
  citations?: Citation[]
  related_questions?: string[]
  engines?: string[]
  model?: string
  is_favorite?: boolean
}

interface UserCapabilities {
  has_tavily: boolean
  has_llm: boolean
  provider: string | null
  model: string | null
}

const API = '/api/plugins/browser'

const SUGGESTIONS = [
  "Quelles sont les dernières avancées en IA ?",
  "Compare Python vs Rust pour le backend",
  "Comment fonctionne le quantum computing ?",
  "Actualités tech cette semaine",
  "Implémenter JWT authentication en Node.js",
  "Microservices vs monolith : différences",
]

const ENGINE_COLORS: Record<string, string> = {
  duckduckgo: '#de5833',
  tavily: '#6366f1',
}

// ── Helpers ───────────────────────────────────────────────────────────────

function TopicIcon({ kind, active }: { kind: string; active: boolean }) {
  const color = active ? 'var(--scarlet)' : 'currentColor'
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (kind === 'globe') {
    return (<svg {...common}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>)
  }
  if (kind === 'news') {
    return (<svg {...common}><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/>
      <path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6z"/></svg>)
  }
  if (kind === 'book') {
    return (<svg {...common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>)
  }
  if (kind === 'code') {
    return (<svg {...common}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>)
  }
  return null
}

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000) - ts)
  if (diff < 60) return "à l'instant"
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)}min`
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`
  return `il y a ${Math.floor(diff / 86400)}j`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function markdownToHtml(md: string, citations: Citation[]): string {
  if (!md) return ''
  const citMap = new Map<number, Citation>()
  citations.forEach(c => citMap.set(c.index, c))

  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  const codeBuf: string[] = []

  const inline = (txt: string): string => {
    let s = escapeHtml(txt)
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\[(\d+)\]/g, (_m, idx) => {
      const c = citMap.get(parseInt(idx))
      const href = c?.url || '#'
      return `<sup><a href="${escapeHtml(href)}" class="hr-cite">[${idx}]</a></sup>`
    })
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    return s
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        codeBuf.length = 0
        inCode = false
      } else { inCode = true }
      continue
    }
    if (inCode) { codeBuf.push(line); continue }
    if (line.startsWith('### ')) out.push(`<h4>${inline(line.slice(4))}</h4>`)
    else if (line.startsWith('## ')) out.push(`<h3>${inline(line.slice(3))}</h3>`)
    else if (line.startsWith('# ')) out.push(`<h2>${inline(line.slice(2))}</h2>`)
    else if (/^[-*]\s/.test(line)) out.push(`<li>${inline(line.slice(2))}</li>`)
    else if (!line.trim()) out.push('')
    else out.push(`<p>${inline(line)}</p>`)
  }
  return out.join('\n')
}

function exportAsPdf(query: string, result: SearchResult) {
  const body = markdownToHtml(result.answer || '', result.citations || [])
  const sources = (result.citations || []).map(c => {
    const host = (() => { try { return new URL(c.url).hostname.replace('www.', '') } catch { return c.url } })()
    return `<li><span class="idx">[${c.index}]</span> <a href="${escapeHtml(c.url)}">${escapeHtml(c.title || host)}</a><div class="host">${escapeHtml(host)}</div></li>`
  }).join('')
  const topicLbl = TOPIC_LABELS[(result.topic || 'web') as Topic] || 'Web'
  const meta = [
    result.pro_search ? 'Mode Pro' : 'Mode Classique',
    topicLbl,
    ...(result.engines || []),
    result.model || '',
    `${result.search_count} sources`,
    new Date().toLocaleString('fr-FR'),
  ].filter(Boolean).map(escapeHtml).join(' • ')

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>HuntR — ${escapeHtml(query)}</title>
<style>
  @page { margin: 18mm; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; line-height: 1.55; max-width: 780px; margin: 0 auto; }
  header { border-bottom: 3px solid #dc2626; padding-bottom: 10px; margin-bottom: 18px; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header h1 .r { color: #dc2626; }
  header .q { font-size: 15px; color: #333; margin: 6px 0 2px; font-weight: 600; }
  header .meta { font-size: 11px; color: #666; }
  h2 { font-size: 17px; color: #111; margin: 16px 0 6px; border-bottom: 1px solid #eee; padding-bottom: 3px; }
  h3 { font-size: 14px; color: #222; margin: 14px 0 4px; }
  h4 { font-size: 13px; color: #333; margin: 10px 0 3px; }
  p { margin: 4px 0 8px; font-size: 12.5px; }
  li { font-size: 12.5px; margin: 3px 0; }
  a { color: #dc2626; text-decoration: none; }
  a.hr-cite { color: #dc2626; font-weight: 700; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 11.5px; }
  pre { background: #f4f4f4; padding: 10px; border-radius: 6px; overflow: auto; font-size: 11px; }
  .sources { margin-top: 24px; border-top: 2px solid #dc2626; padding-top: 12px; }
  .sources h2 { border: none; margin-top: 0; }
  .sources ol { list-style: none; padding: 0; }
  .sources li { margin: 8px 0; padding: 8px; background: #fafafa; border-left: 3px solid #dc2626; border-radius: 3px; }
  .sources .idx { font-weight: 700; color: #dc2626; margin-right: 5px; }
  .sources .host { font-size: 10.5px; color: #888; margin-top: 2px; }
  footer { margin-top: 30px; font-size: 10px; color: #999; text-align: center; border-top: 1px solid #eee; padding-top: 10px; }
</style></head><body>
<header>
  <h1>Hunt<span class="r">R</span></h1>
  <div class="q">${escapeHtml(query)}</div>
  <div class="meta">${meta}</div>
</header>
<main>${body}</main>
<section class="sources"><h2>Sources (${(result.citations || []).length})</h2><ol>${sources}</ol></section>
<footer>Généré par HuntR — Gungnir</footer>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
</body></html>`

  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) {
    alert('Popup bloquée. Autorisez les popups pour exporter en PDF.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
}

// ── Main Component ────────────────────────────────────────────────────────

export default function HuntRPlugin() {
  const { selectedProvider, selectedModel } = useStore()

  const [query, setQuery] = useState('')
  const [proSearch, setProSearch] = useState(false)
  const [topic, setTopic] = useState<Topic>('web')
  const [searching, setSearching] = useState(false)
  const [status, setStatus] = useState('')
  const [currentStep, setCurrentStep] = useState(0)
  const [totalSteps, setTotalSteps] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [liveSources, setLiveSources] = useState<LiveSource[]>([])
  const [error, setError] = useState('')
  const [caps, setCaps] = useState<UserCapabilities | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshHistory = useCallback(() => {
    const qs = favoritesOnly ? '?limit=30&favorites_only=true' : '?limit=30'
    fetch(`${API}/history${qs}`)
      .then(r => r.json())
      .then(d => setHistory(d.history || []))
      .catch(() => {})
  }, [favoritesOnly])

  // ── Init: check user capabilities ─────────────────────────────────
  useEffect(() => {
    fetch(`${API}/user-capabilities`)
      .then(r => r.json())
      .then(d => setCaps(d))
      .catch(() => {})
  }, [])

  // ── Reload history when filter changes ────────────────────────────
  useEffect(() => { refreshHistory() }, [refreshHistory])

  const toggleFavorite = useCallback(async (entry: HistoryEntry) => {
    if (!entry.id) return
    const next = !entry.is_favorite
    // Optimistic update
    setHistory(h => h.map(x => x.id === entry.id ? { ...x, is_favorite: next } : x))
    try {
      await fetch(`${API}/history/${entry.id}/favorite`, {
        method: next ? 'POST' : 'DELETE',
      })
    } catch {
      // Revert on error
      setHistory(h => h.map(x => x.id === entry.id ? { ...x, is_favorite: !next } : x))
    }
  }, [])

  const deleteEntry = useCallback(async (id: number) => {
    setHistory(h => h.filter(x => x.id !== id))
    try {
      await fetch(`${API}/history/${id}`, { method: 'DELETE' })
    } catch {
      refreshHistory()
    }
  }, [refreshHistory])

  // ── Search ────────────────────────────────────────────────────────
  const doSearch = useCallback(async (overrideQuery?: string) => {
    const q = (overrideQuery || query).trim()
    if (!q) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSearching(true)
    setStatus('Initialisation...')
    setCurrentStep(0)
    setTotalSteps(0)
    setResult(null)
    setLiveSources([])
    setError('')
    if (overrideQuery) setQuery(overrideQuery)

    try {
      const resp = await fetch(`${API}/search/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          pro_search: proSearch,
          topic: topic,
          max_results: 10,
          provider: selectedProvider,
          model: selectedModel,
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${resp.status}`)
      }
      if (!resp.body) throw new Error('Streaming non supporté')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamDone = false
      const final: Partial<SearchResult> = {
        answer: '', citations: [], related_questions: [],
        search_count: 0, pro_search: proSearch, topic,
        engines: [], time_ms: 0,
      }

      try {
        while (!streamDone) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const chunk = JSON.parse(line.slice(6))
              const d = chunk.data || {}

              switch (chunk.type) {
                case 'status':
                  setStatus(d.message || '')
                  if (d.step) setCurrentStep(d.step)
                  if (d.total_steps) setTotalSteps(d.total_steps)
                  break
                case 'search':
                  final.search_count = d.count || 0
                  final.engines = d.engines || []
                  if (d.results) setLiveSources(d.results)
                  break
                case 'citation':
                  final.citations = d.citations || []
                  setResult({ ...final } as SearchResult)
                  break
                case 'chunk':
                  // Streaming token from LLM
                  final.answer += (d.token || '')
                  setResult({ ...final } as SearchResult)
                  break
                case 'content':
                  // Full answer (classic mode or fallback)
                  final.answer = d.answer || ''
                  setResult({ ...final } as SearchResult)
                  break
                case 'related':
                  final.related_questions = d.questions || []
                  setResult({ ...final } as SearchResult)
                  break
                case 'done':
                  final.time_ms = d.time_ms || 0
                  final.search_count = d.search_count || final.search_count
                  final.pro_search = d.pro_search ?? proSearch
                  final.topic = (d.topic as Topic) || topic
                  final.engines = d.engines || final.engines
                  final.model = d.model
                  final.error = d.error
                  setResult({ ...final } as SearchResult)
                  setActiveHistoryId(null)
                  refreshHistory()
                  streamDone = true
                  break
                case 'error':
                  setError(d.message || 'Erreur inconnue')
                  streamDone = true
                  break
              }
            } catch { /* skip malformed SSE */ }
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError(e.message)
      }
    } finally {
      setSearching(false)
      setStatus('')
    }
  }, [query, proSearch, topic, selectedProvider, selectedModel, refreshHistory])

  const handleClear = () => {
    setResult(null)
    setQuery('')
    setError('')
    setLiveSources([])
    setCurrentStep(0)
    setTotalSteps(0)
    inputRef.current?.focus()
  }

  const loadFromHistory = (h: HistoryEntry) => {
    if (h.answer) {
      // Cached result — display directly
      setQuery(h.query)
      setError('')
      setLiveSources([])
      setSearching(false)
      setStatus('')
      setCurrentStep(0)
      setTotalSteps(0)
      setActiveHistoryId(h.id ?? null)
      setResult({
        answer: h.answer,
        citations: h.citations || [],
        related_questions: h.related_questions || [],
        search_count: h.sources_count,
        pro_search: h.mode === 'pro',
        topic: (h.topic || 'web') as Topic,
        engines: h.engines || [],
        time_ms: h.time_ms,
        model: h.model,
      })
    } else {
      // No cached answer — re-run search
      setQuery(h.query)
      doSearch(h.query)
    }
  }

  const hasResults = result || searching
  const canPro = caps?.has_tavily && caps?.has_llm

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)',
      overflow: 'hidden',
    }}>

      {/* Header */}
      <div style={{
        padding: '12px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: 'linear-gradient(135deg, var(--scarlet), var(--ember))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em' }}>
            Hunt<span style={{ color: 'var(--scarlet)' }}>R</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>v3</span>
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
            Recherche web avec citations
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => setShowHistory(!showHistory)}
            style={{
              padding: '5px 10px', borderRadius: 6, fontSize: 11,
              background: showHistory ? 'var(--scarlet-light)' : 'var(--bg-tertiary)',
              color: showHistory ? 'var(--scarlet)' : 'var(--text-secondary)',
              border: '1px solid var(--border)', cursor: 'pointer',
            }}
          >
            Historique
          </button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', width: '100%', padding: '0 24px' }}>

            {/* Search Area */}
            <div style={{
              padding: hasResults ? '16px 0' : '0',
              ...(!hasResults ? {
                display: 'flex', flexDirection: 'column' as const,
                alignItems: 'center', justifyContent: 'center',
                minHeight: 'calc(100vh - 180px)',
              } : {}),
            }}>
              {/* Hero (idle) */}
              {!hasResults && (
                <div style={{ textAlign: 'center', marginBottom: 28 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: 14, margin: '0 auto 14px',
                    background: 'linear-gradient(135deg, var(--scarlet-light), var(--ember-light, rgba(234,88,12,0.15)))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </div>
                  <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.02em' }}>
                    Hunt<span style={{ color: 'var(--scarlet)' }}>R</span>
                  </h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
                    Posez une question. Obtenez une réponse sourcée.
                  </p>

                  {/* Tavily promo if not configured */}
                  {caps && !caps.has_tavily && (
                    <div style={{
                      marginTop: 16, padding: '12px 16px', borderRadius: 10,
                      background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)',
                      fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left',
                      maxWidth: 480, margin: '16px auto 0',
                    }}>
                      <strong style={{ color: 'var(--accent-primary)' }}>Débloquez le mode Pro</strong>
                      <p style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
                        Créez un compte gratuit sur{' '}
                        <a href="https://app.tavily.com/sign-in" target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                          Tavily (1000 req/mois gratuites)
                        </a>
                        {' '}puis ajoutez votre clé dans{' '}
                        <a href="/settings?tab=services" style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                          Paramètres &rarr; Services &rarr; Tavily
                        </a>.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Search bar */}
              <div style={{
                display: 'flex', gap: 8, width: '100%',
                maxWidth: !hasResults ? 640 : undefined,
              }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}>
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    ref={inputRef} type="text" value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && doSearch()}
                    placeholder="Posez votre question..."
                    style={{
                      width: '100%', padding: '11px 14px 11px 40px', borderRadius: 10,
                      border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)', fontSize: 14, outline: 'none',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--scarlet)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                {/* Pro toggle */}
                <button
                  onClick={() => canPro && setProSearch(!proSearch)}
                  title={canPro ? 'Tavily + LLM' : 'Configurez Tavily + un provider LLM pour activer le mode Pro'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '11px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                    background: proSearch
                      ? 'linear-gradient(135deg, var(--amber-light, rgba(245,158,11,0.15)), var(--ember-light, rgba(234,88,12,0.1)))'
                      : 'var(--bg-secondary)',
                    border: proSearch
                      ? '1px solid var(--amber, #f59e0b)'
                      : '1px solid var(--border)',
                    color: proSearch ? 'var(--amber, #f59e0b)' : 'var(--text-muted)',
                    cursor: canPro ? 'pointer' : 'not-allowed',
                    opacity: canPro ? 1 : 0.4,
                    flexShrink: 0,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24"
                    fill={proSearch ? 'var(--amber, #f59e0b)' : 'none'}
                    stroke={proSearch ? 'var(--amber, #f59e0b)' : 'currentColor'} strokeWidth="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                  </svg>
                  Pro
                </button>

                {/* Search button */}
                <button
                  onClick={() => doSearch()}
                  disabled={searching || !query.trim()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '11px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                    background: 'linear-gradient(135deg, var(--scarlet), var(--ember, #ea580c))',
                    color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0,
                    opacity: searching || !query.trim() ? 0.5 : 1,
                  }}
                >
                  {searching ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      style={{ animation: 'huntr-spin 1s linear infinite' }}>
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                    </svg>
                  )}
                  Rechercher
                </button>
              </div>

              {/* Topic segmented control */}
              <div style={{
                display: 'flex', gap: 6, marginTop: 10, width: '100%',
                maxWidth: !hasResults ? 640 : undefined, flexWrap: 'wrap',
              }}>
                {TOPICS.map(t => {
                  const active = topic === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTopic(t.id)}
                      title={t.desc}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '7px 12px', borderRadius: 999, fontSize: 12,
                        fontWeight: active ? 600 : 500,
                        background: active
                          ? 'linear-gradient(135deg, rgba(220,38,38,0.15), rgba(234,88,12,0.1))'
                          : 'var(--bg-secondary)',
                        border: active ? '1px solid var(--scarlet)' : '1px solid var(--border)',
                        color: active ? 'var(--scarlet)' : 'var(--text-muted)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <TopicIcon kind={t.icon} active={active} />
                      {t.label}
                    </button>
                  )
                })}
              </div>

              {/* Suggestions (idle) */}
              {!hasResults && (
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 6, marginTop: 16, maxWidth: 640, width: '100%',
                }}>
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i}
                      onClick={() => { setQuery(s); doSearch(s) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '9px 12px', borderRadius: 8, fontSize: 12,
                        background: 'var(--bg-secondary)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', cursor: 'pointer',
                        textAlign: 'left', transition: 'border-color 0.15s',
                      }}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--scarlet)'}
                      onMouseOut={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      </svg>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Status + progress bar */}
            {status && (
              <div style={{
                padding: '10px 14px', borderRadius: 10, margin: '6px 0',
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: totalSteps > 1 ? 8 : 0 }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%',
                    border: '2px solid var(--scarlet)', borderTopColor: 'transparent',
                    animation: 'huntr-spin 0.8s linear infinite', flexShrink: 0,
                  }} />
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, flex: 1 }}>{status}</span>
                  {totalSteps > 1 && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>
                      {currentStep}/{totalSteps}
                    </span>
                  )}
                </div>
                {/* Progress bar (Pro mode only) */}
                {totalSteps > 1 && (
                  <div style={{ display: 'flex', gap: 3 }}>
                    {Array.from({ length: totalSteps }, (_, i) => {
                      const step = i + 1
                      const isActive = step <= currentStep
                      const isCurrent = step === currentStep
                      return (
                        <div key={step} style={{
                          flex: 1, height: 4, borderRadius: 2,
                          background: isActive ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                          opacity: isCurrent ? 1 : isActive ? 0.7 : 0.3,
                          transition: 'all 0.4s ease',
                        }} />
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Live sources during search */}
            {searching && liveSources.length > 0 && !result?.answer && (
              <div style={{
                padding: 12, borderRadius: 10, margin: '6px 0',
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                  marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                  </svg>
                  Sources trouvées...
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {liveSources.slice(0, 8).map((s, i) => {
                    let host = s.url
                    try { host = new URL(s.url).hostname.replace('www.', '') } catch {}
                    return (
                      <div key={i} style={{
                        padding: '4px 8px', borderRadius: 6, fontSize: 11,
                        background: 'var(--bg-primary)', border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', gap: 4,
                        animation: 'huntr-fadeIn 0.3s ease-out',
                        animationDelay: `${i * 0.05}s`, animationFillMode: 'both',
                      }}>
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: ENGINE_COLORS[s.source || ''] || 'var(--text-muted)', flexShrink: 0,
                        }} />
                        <span style={{ color: 'var(--text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {host}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{
                padding: '10px 14px', borderRadius: 10, margin: '6px 0',
                background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.25)',
              }}>
                <p style={{ fontWeight: 600, fontSize: 12, color: '#ef4444', margin: '0 0 2px' }}>Erreur</p>
                <p style={{ fontSize: 12, color: '#f87171', margin: 0 }}>{error}</p>
              </div>
            )}

            {/* Results */}
            {result && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 32 }}>

                {/* Meta bar */}
                {result.time_ms > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {result.pro_search && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600,
                        background: 'var(--amber-light, rgba(245,158,11,0.15))',
                        color: 'var(--amber, #f59e0b)',
                        border: '1px solid var(--amber, #f59e0b)',
                      }}>
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                        Pro
                      </span>
                    )}
                    {result.topic && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600,
                        background: 'rgba(220,38,38,0.1)', color: 'var(--scarlet)',
                        border: '1px solid var(--scarlet)',
                      }}>
                        <TopicIcon kind={TOPICS.find(t => t.id === result.topic)?.icon || 'globe'} active />
                        {TOPIC_LABELS[result.topic]}
                      </span>
                    )}
                    {result.engines.map(e => (
                      <span key={e} style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500,
                        background: 'var(--bg-tertiary)', color: ENGINE_COLORS[e] || 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}>
                        {e}
                      </span>
                    ))}
                    {result.model && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 10,
                        background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}>
                        {result.model}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {result.search_count} sources &middot; {result.time_ms}ms
                    </span>
                    {result.answer && !searching && (
                      <button
                        onClick={() => exportAsPdf(query, result)}
                        title="Exporter la réponse en PDF"
                        style={{
                          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 600,
                          background: 'var(--bg-tertiary)', color: 'var(--scarlet)',
                          border: '1px solid var(--scarlet)', cursor: 'pointer',
                        }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        PDF
                      </button>
                    )}
                  </div>
                )}

                {/* Answer card */}
                {result.answer && (
                  <div style={{
                    padding: 18, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    lineHeight: 1.7, fontSize: 14,
                  }}>
                    <MarkdownRenderer text={result.answer} citations={result.citations} onCiteClick={scrollToSource} />
                  </div>
                )}

                {/* Skeleton */}
                {searching && !result.answer && (
                  <div style={{
                    padding: 18, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    display: 'flex', flexDirection: 'column', gap: 10,
                  }}>
                    {[75, 100, 85, 60].map((w, i) => (
                      <div key={i} style={{
                        height: 12, borderRadius: 6, width: `${w}%`,
                        background: 'var(--bg-tertiary)',
                        animation: 'huntr-pulse 1.5s ease-in-out infinite',
                        animationDelay: `${i * 0.15}s`,
                      }} />
                    ))}
                  </div>
                )}

                {/* Sources */}
                {result.citations.length > 0 && (
                  <div style={{
                    padding: 14, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 600, margin: '0 0 10px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      color: 'var(--text-primary)',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
                        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                      </svg>
                      Sources ({result.citations.length})
                    </h3>
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                      gap: 6,
                    }}>
                      {result.citations.map(c => {
                        let host = c.url
                        try { host = new URL(c.url).hostname.replace('www.', '') } catch {}
                        return (
                          <a key={c.index} id={`huntr-source-${c.index}`}
                            href={c.url} target="_blank" rel="noopener noreferrer"
                            className="huntr-source-card"
                            style={{
                              display: 'flex', gap: 8, padding: 8, borderRadius: 8,
                              background: 'var(--bg-primary)', border: '1px solid var(--border)',
                              textDecoration: 'none', color: 'inherit',
                              transition: 'border-color 0.2s, transform 0.2s, box-shadow 0.2s',
                            }}
                            onMouseOver={e => {
                              const el = e.currentTarget as HTMLElement
                              el.style.borderColor = 'var(--scarlet)'
                              el.style.transform = 'scale(1.03)'
                              el.style.boxShadow = '0 4px 12px rgba(220,38,38,0.15)'
                            }}
                            onMouseOut={e => {
                              const el = e.currentTarget as HTMLElement
                              el.style.borderColor = 'var(--border)'
                              el.style.transform = 'scale(1)'
                              el.style.boxShadow = 'none'
                            }}
                          >
                            <div style={{
                              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 10, fontWeight: 700, background: 'var(--scarlet)', color: '#fff',
                            }}>
                              {c.index}
                            </div>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{
                                fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {c.title || host}
                              </div>
                              <div style={{
                                fontSize: 10, color: 'var(--text-muted)', marginTop: 1,
                                display: 'flex', alignItems: 'center', gap: 3,
                              }}>
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                                </svg>
                                {host}
                              </div>
                            </div>
                          </a>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Related questions */}
                {result.related_questions.length > 0 && (
                  <div style={{
                    padding: 14, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 600, margin: '0 0 8px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      color: 'var(--text-primary)',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
                        <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"/>
                      </svg>
                      Questions similaires
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {result.related_questions.map((q, i) => (
                        <button key={i}
                          onClick={() => { setQuery(q); doSearch(q) }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 12px', borderRadius: 8, fontSize: 12,
                            background: 'var(--bg-primary)', color: 'var(--text-muted)',
                            border: '1px solid var(--border)', cursor: 'pointer',
                            textAlign: 'left', transition: 'border-color 0.15s',
                          }}
                          onMouseOver={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--scarlet)'}
                          onMouseOut={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                          </svg>
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* New search */}
                {!searching && (
                  <button onClick={handleClear} style={{
                    alignSelf: 'center', padding: '7px 18px', borderRadius: 8,
                    background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                    border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12,
                  }}>
                    Nouvelle recherche
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* History sidebar */}
        {showHistory && (
          <div style={{
            width: 260, borderLeft: '1px solid var(--border)',
            background: 'var(--bg-secondary)', overflow: 'auto',
            padding: 10, flexShrink: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Historique</h3>
              {history.length > 0 && !favoritesOnly && (
                <button
                  onClick={async () => {
                    if (!confirm('Effacer l\'historique (hors favoris) ?')) return
                    await fetch(`${API}/history?keep_favorites=true`, { method: 'DELETE' })
                    refreshHistory()
                  }}
                  title="Effacer (conserve les favoris)"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10 }}>
                  Effacer
                </button>
              )}
            </div>

            {/* Filter tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              <button
                onClick={() => setFavoritesOnly(false)}
                style={{
                  flex: 1, padding: '4px 6px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                  background: !favoritesOnly ? 'var(--scarlet-light)' : 'var(--bg-tertiary)',
                  color: !favoritesOnly ? 'var(--scarlet)' : 'var(--text-muted)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >Tout</button>
              <button
                onClick={() => setFavoritesOnly(true)}
                style={{
                  flex: 1, padding: '4px 6px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                  background: favoritesOnly ? 'var(--scarlet-light)' : 'var(--bg-tertiary)',
                  color: favoritesOnly ? 'var(--scarlet)' : 'var(--text-muted)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                }}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                Favoris
              </button>
            </div>

            {history.length === 0 ? (
              <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {favoritesOnly ? 'Aucun favori' : 'Aucune recherche récente'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {history.map((h) => {
                  const isActive = h.id != null && h.id === activeHistoryId
                  return (
                    <div key={h.id ?? h.timestamp}
                      style={{
                        display: 'flex', alignItems: 'stretch', gap: 2,
                        borderRadius: 6,
                        background: 'var(--bg-tertiary)',
                        border: isActive ? '1px solid var(--scarlet)' : '1px solid transparent',
                        transition: 'border-color 0.15s',
                      }}
                      onMouseOver={e => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
                      onMouseOut={e => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
                    >
                      <button
                        onClick={() => loadFromHistory(h)}
                        style={{
                          flex: 1, padding: '7px 8px', fontSize: 11,
                          background: 'transparent', color: 'var(--text-primary)',
                          border: 'none', cursor: 'pointer',
                          textAlign: 'left', lineHeight: 1.3, minWidth: 0,
                          overflow: 'hidden',
                        }}
                      >
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {h.query}
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>{h.sources_count} sources</span>
                          {h.mode === 'pro' && <span style={{ color: 'var(--amber, #f59e0b)' }}>Pro</span>}
                          {h.topic && h.topic !== 'web' && (
                            <span style={{ color: 'var(--scarlet)' }}>{TOPIC_LABELS[h.topic]}</span>
                          )}
                          {h.answer ? <span style={{ color: 'var(--scarlet)' }}>cache</span> : null}
                          <span>{formatTimeAgo(h.timestamp)}</span>
                        </div>
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', padding: 2, gap: 2 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(h) }}
                          title={h.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            padding: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: h.is_favorite ? 'var(--amber, #f59e0b)' : 'var(--text-muted)',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24"
                            fill={h.is_favorite ? 'currentColor' : 'none'}
                            stroke="currentColor" strokeWidth="2">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                          </svg>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); if (h.id) deleteEntry(h.id) }}
                          title="Supprimer"
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            padding: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--text-muted)',
                          }}
                          onMouseOver={e => (e.currentTarget as HTMLElement).style.color = '#ef4444'}
                          onMouseOut={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes huntr-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes huntr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes huntr-fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  )
}


// ── Scroll helper ─────────────────────────────────────────────────────────

function scrollToSource(idx: number) {
  const el = document.getElementById(`huntr-source-${idx}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}


// ── Citation tooltip ──────────────────────────────────────────────────────

function CitationBadge({ idx, citation, onClick }: {
  idx: number; citation?: Citation; onClick?: (idx: number) => void
}) {
  const [hover, setHover] = useState(false)
  let host = ''
  if (citation?.url) {
    try { host = new URL(citation.url).hostname.replace('www.', '') } catch {}
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button onClick={() => onClick?.(idx)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: '50%', fontSize: 9, fontWeight: 700,
          background: 'var(--scarlet)', color: '#fff',
          border: 'none', cursor: 'pointer', verticalAlign: 'super', margin: '0 1px',
          transition: 'transform 0.15s',
          transform: hover ? 'scale(1.2)' : 'scale(1)',
        }}
      >
        {idx}
      </button>
      {/* Tooltip */}
      {hover && citation && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 6, width: 280, padding: '10px 12px', borderRadius: 10,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)', zIndex: 100,
          pointerEvents: 'none', animation: 'huntr-fadeIn 0.15s ease-out',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, background: 'var(--scarlet)', color: '#fff',
            }}>{idx}</div>
            <span style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>
              {citation.title || host}
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            {host}
          </div>
          {citation.snippet && (
            <p style={{
              fontSize: 11, color: 'var(--text-secondary)', margin: 0,
              lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
              {citation.snippet}
            </p>
          )}
        </div>
      )}
    </span>
  )
}


// ── Markdown Renderer with citation tooltips ──────────────────────────────

function MarkdownRenderer({ text, citations, onCiteClick }: {
  text: string; citations?: Citation[]; onCiteClick?: (idx: number) => void
}) {
  if (!text) return null

  const citationMap = new Map<number, Citation>()
  if (citations) citations.forEach(c => citationMap.set(c.index, c))

  const lines = text.split('\n')
  const elements: JSX.Element[] = []
  let key = 0

  const parse = (t: string) => inlineParse(t, key, citationMap, onCiteClick)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('### ')) {
      elements.push(<h4 key={key++} style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 4px', color: 'var(--text-primary)' }}>{parse(line.slice(4))}</h4>)
    } else if (line.startsWith('## ')) {
      elements.push(<h3 key={key++} style={{ fontSize: 15, fontWeight: 700, margin: '14px 0 4px', color: 'var(--text-primary)' }}>{parse(line.slice(3))}</h3>)
    } else if (line.startsWith('# ')) {
      elements.push(<h2 key={key++} style={{ fontSize: 16, fontWeight: 700, margin: '16px 0 6px', color: 'var(--text-primary)' }}>{parse(line.slice(2))}</h2>)
    } else if (/^[-*]\s/.test(line)) {
      elements.push(
        <div key={key++} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 8 }}>
          <span style={{ color: 'var(--scarlet)', flexShrink: 0 }}>&#8226;</span>
          <span style={{ color: 'var(--text-secondary)' }}>{parse(line.slice(2))}</span>
        </div>
      )
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)/)
      if (match) {
        elements.push(
          <div key={key++} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 8 }}>
            <span style={{ color: 'var(--scarlet)', flexShrink: 0, fontWeight: 600, fontSize: 12 }}>{match[1]}.</span>
            <span style={{ color: 'var(--text-secondary)' }}>{parse(match[2])}</span>
          </div>
        )
      }
    } else if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      elements.push(
        <pre key={key++} style={{
          padding: 12, borderRadius: 8, margin: '8px 0', overflow: 'auto',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ember, #ea580c)',
        }}>
          {codeLines.join('\n')}
        </pre>
      )
    } else if (!line.trim()) {
      elements.push(<div key={key++} style={{ height: 6 }} />)
    } else {
      elements.push(<p key={key++} style={{ margin: '2px 0', color: 'var(--text-secondary)' }}>{parse(line)}</p>)
    }
  }

  return <>{elements}</>
}


function inlineParse(
  text: string, baseKey: number,
  citationMap: Map<number, Citation>,
  onCiteClick?: (idx: number) => void
): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[(\d+)\]|\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let k = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    const key = `${baseKey}-${k++}`
    if (match[2]) {
      parts.push(<strong key={key} style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{match[2]}</strong>)
    } else if (match[3]) {
      parts.push(<em key={key} style={{ color: 'var(--text-primary)' }}>{match[3]}</em>)
    } else if (match[4]) {
      parts.push(<code key={key} style={{
        padding: '1px 5px', borderRadius: 4, fontSize: 12,
        background: 'var(--bg-tertiary)', color: 'var(--scarlet)',
        fontFamily: 'JetBrains Mono, monospace',
      }}>{match[4]}</code>)
    } else if (match[5]) {
      const idx = parseInt(match[5])
      parts.push(<CitationBadge key={key} idx={idx} citation={citationMap.get(idx)} onClick={onCiteClick} />)
    } else if (match[6] && match[7]) {
      parts.push(
        <a key={key} href={match[7]} target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--scarlet)', textDecoration: 'underline' }}>
          {match[6]}
        </a>
      )
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length > 0 ? parts : [text]
}
