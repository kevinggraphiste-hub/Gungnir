/**
 * HuntR — Perplexity-like Search Engine for Gungnir
 *
 * Features:
 *  - Mode Normal (gratuit) : search + scrape + citations, pas de LLM
 *  - Mode Pro : search + scrape + synthèse LLM + related questions
 *  - Focus modes : Web, Code, Actu, Academic
 *  - Follow-up conversationnel (session context)
 *  - Multi-engine badges (DDG, Brave, SearXNG, Wikipedia)
 *  - Progressive streaming (sources en temps réel)
 *
 * 100% plugin — aucune dépendance core sauf CSS variables.
 */
import { useState, useRef, useCallback, useEffect } from 'react'
import { useStore } from '@core/stores/appStore'

// ── Types ──────────────────────────────────────────────────────────────────

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
  passages_used: number
  pro_search: boolean
  intent: string
  focus: string
  engines: string[]
  time_ms: number
}

interface HistoryEntry {
  query: string
  sources_count: number
  mode: string
  intent: string
  focus: string
  engines: string[]
  time_ms: number
  timestamp: number
}

interface LiveSource {
  title: string
  url: string
  snippet?: string
  source?: string
  words?: number
}

const API = '/api/plugins/browser'

const FOCUS_MODES = [
  { key: 'web', label: 'Web', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' },
  { key: 'code', label: 'Code', icon: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z' },
  { key: 'news', label: 'Actu', icon: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z' },
  { key: 'academic', label: 'Academic', icon: 'M12 3L1 9l4 2.18v6L12 21l7-3.82v-6l2-1.09V17h2V9L12 3zm6.82 6L12 12.72 5.18 9 12 5.28 18.82 9zM17 15.99l-5 2.73-5-2.73v-3.72L12 15l5-2.73v3.72z' },
]

const SUGGESTIONS = [
  { text: "Quelles sont les dernieres avancees en IA ?", focus: "web" },
  { text: "Compare Python vs Rust pour le backend", focus: "code" },
  { text: "Comment fonctionne le quantum computing ?", focus: "academic" },
  { text: "Actualites tech cette semaine", focus: "news" },
  { text: "Implementer JWT authentication Node.js", focus: "code" },
  { text: "Microservices vs monolith : differences", focus: "web" },
]

const ENGINE_COLORS: Record<string, string> = {
  duckduckgo: '#de5833',
  brave: '#fb542b',
  searxng: '#3b82f6',
  wikipedia: '#636466',
}

// ── Helpers ────────────────────────────────────────────────────────────────

function generateSessionId(): string {
  return 'huntr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000) - ts)
  if (diff < 60) return "a l'instant"
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)}min`
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`
  return `il y a ${Math.floor(diff / 86400)}j`
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function HuntRPlugin() {
  const { selectedProvider, selectedModel } = useStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [proSearch, setProSearch] = useState(false)
  const [focus, setFocus] = useState('web')
  const [searching, setSearching] = useState(false)
  const [searchStatus, setSearchStatus] = useState('')
  const [currentStep, setCurrentStep] = useState(0)
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [liveSources, setLiveSources] = useState<LiveSource[]>([])
  const [searchError, setSearchError] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [sessionId] = useState(() => generateSessionId())

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`${API}/history?limit=30`)
      .then(r => r.json())
      .then(d => setHistory(d.history || []))
      .catch(() => {})
  }, [])

  const doSearch = useCallback(async (query?: string, forceFocus?: string) => {
    const q = (query || searchQuery).trim()
    if (!q || searching) return

    setSearching(true)
    setSearchStatus('Initialisation...')
    setCurrentStep(0)
    setSearchResult(null)
    setLiveSources([])
    setSearchError('')
    if (query) setSearchQuery(query)

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const resp = await fetch(`${API}/search/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q, pro_search: proSearch,
          focus: forceFocus || focus,
          max_results: 15, session_id: sessionId,
          provider: selectedProvider, model: selectedModel,
        }),
        signal: controller.signal,
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      if (!resp.body) throw new Error('Streaming non supporté')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const finalResult: Partial<SearchResult> = {
        answer: '', citations: [], related_questions: [],
        search_count: 0, passages_used: 0, pro_search: proSearch,
        intent: '', focus: forceFocus || focus, engines: [], time_ms: 0,
      }
      let streamedAnswer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const chunk = JSON.parse(line.slice(6))
            const data = chunk.data || {}
            switch (chunk.type) {
              case 'status':
                setSearchStatus(data.message || '')
                if (data.step) setCurrentStep(data.step)
                if (data.focus) setFocus(data.focus)
                break
              case 'search':
                finalResult.search_count = data.count || 0
                finalResult.engines = data.engines || []
                // Show live sources immediately
                if (data.results) {
                  setLiveSources(data.results)
                }
                setSearchStatus(`${data.count} resultats via ${(data.engines || []).join(', ')}`)
                break
              case 'sources':
                // Progressive source display during scraping
                if (data.sources) {
                  setLiveSources(prev => {
                    const urls = new Set(prev.map(s => s.url))
                    const news = data.sources.filter((s: LiveSource) => !urls.has(s.url))
                    return [...prev, ...news]
                  })
                }
                break
              case 'chunk':
                streamedAnswer += data.content || ''
                finalResult.answer = streamedAnswer
                setSearchResult({ ...finalResult } as SearchResult)
                break
              case 'content':
                finalResult.answer = data.answer || streamedAnswer
                setSearchResult({ ...finalResult } as SearchResult)
                break
              case 'citation':
                finalResult.citations = data.citations || []
                setSearchResult({ ...finalResult } as SearchResult)
                break
              case 'related':
                finalResult.related_questions = data.questions || []
                setSearchResult({ ...finalResult } as SearchResult)
                break
              case 'done':
                Object.assign(finalResult, {
                  time_ms: data.time_ms || 0,
                  search_count: data.search_count || finalResult.search_count,
                  passages_used: data.passages_used || 0,
                  pro_search: data.pro_search ?? proSearch,
                  intent: data.intent || '',
                  focus: data.focus || focus,
                  engines: data.engines || finalResult.engines,
                })
                setSearchResult({ ...finalResult } as SearchResult)
                fetch(`${API}/history?limit=30`)
                  .then(r => r.json())
                  .then(d => setHistory(d.history || []))
                  .catch(() => {})
                break
              case 'error':
                setSearchError(data.message || 'Erreur inconnue')
                break
            }
          } catch { /* skip malformed SSE */ }
        }
      }
      setSearchStatus('')
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setSearchError(e.message)
        setSearchStatus('')
      }
    } finally {
      setSearching(false)
    }
  }, [searchQuery, proSearch, focus, searching, sessionId])

  const scrollToSource = (idx: number) => {
    const el = document.getElementById(`huntr-source-${idx}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleClear = () => {
    setSearchResult(null)
    setSearchQuery('')
    setSearchError('')
    setSearchStatus('')
    setLiveSources([])
    setCurrentStep(0)
    inputRef.current?.focus()
  }

  const hasResults = searchResult || searching

  // ── Render ─────────────────────────────────────────────────────────────

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
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
            Recherche multi-sources avec citations
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Step indicator during search */}
          {searching && currentStep > 0 && (
            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              {[1,2,3,4,5].map(s => (
                <div key={s} style={{
                  width: s <= (proSearch ? 5 : 4) ? 20 : 0,
                  height: 3, borderRadius: 2,
                  background: s <= currentStep ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                  transition: 'background 0.3s',
                  display: s <= (proSearch ? 5 : 4) ? 'block' : 'none',
                }} />
              ))}
            </div>
          )}
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
              {/* Hero (idle state) */}
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
                    Posez une question. Obtenez une reponse sourcee.
                  </p>
                </div>
              )}

              {/* Focus mode tabs */}
              <div style={{
                display: 'flex', gap: 4, marginBottom: 10,
                justifyContent: !hasResults ? 'center' : 'flex-start',
              }}>
                {FOCUS_MODES.map(m => (
                  <button key={m.key}
                    onClick={() => setFocus(m.key)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500,
                      background: focus === m.key ? 'var(--scarlet-light)' : 'transparent',
                      color: focus === m.key ? 'var(--scarlet)' : 'var(--text-muted)',
                      border: focus === m.key ? '1px solid var(--scarlet)' : '1px solid transparent',
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d={m.icon}/>
                    </svg>
                    {m.label}
                  </button>
                ))}
              </div>

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
                    ref={inputRef} type="text" value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
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
                  onClick={() => setProSearch(!proSearch)}
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
                    cursor: 'pointer', flexShrink: 0,
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
                  disabled={searching || !searchQuery.trim()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '11px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                    background: 'linear-gradient(135deg, var(--scarlet), var(--ember, #ea580c))',
                    color: '#fff', border: 'none', cursor: 'pointer', flexShrink: 0,
                    opacity: searching || !searchQuery.trim() ? 0.5 : 1,
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

              {/* Suggestions (idle) */}
              {!hasResults && (
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 6, marginTop: 16, maxWidth: 640, width: '100%',
                }}>
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i}
                      onClick={() => { setFocus(s.focus); setSearchQuery(s.text); doSearch(s.text, s.focus) }}
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
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Status bar */}
            {searchStatus && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px', borderRadius: 8, margin: '6px 0',
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              }}>
                <div style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: '2px solid var(--scarlet)', borderTopColor: 'transparent',
                  animation: 'huntr-spin 0.8s linear infinite', flexShrink: 0,
                }} />
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{searchStatus}</span>
              </div>
            )}

            {/* Live sources during search */}
            {searching && liveSources.length > 0 && !searchResult?.answer && (
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
                  Sources en cours de lecture...
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {liveSources.slice(0, 8).map((s, i) => {
                    let host = s.url
                    try { host = new URL(s.url).hostname.replace('www.', '') } catch {}
                    const engineColor = ENGINE_COLORS[s.source || ''] || 'var(--text-muted)'
                    return (
                      <div key={i} style={{
                        padding: '4px 8px', borderRadius: 6, fontSize: 11,
                        background: 'var(--bg-primary)', border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', gap: 4,
                        animation: 'huntr-fadeIn 0.3s ease-out',
                        animationDelay: `${i * 0.05}s`,
                        animationFillMode: 'both',
                      }}>
                        <div style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: engineColor, flexShrink: 0,
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
            {searchError && (
              <div style={{
                padding: '10px 14px', borderRadius: 10, margin: '6px 0',
                background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.25)',
              }}>
                <p style={{ fontWeight: 600, fontSize: 12, color: '#ef4444', margin: '0 0 2px' }}>Erreur</p>
                <p style={{ fontSize: 12, color: '#f87171', margin: 0 }}>{searchError}</p>
              </div>
            )}

            {/* Results */}
            {searchResult && (
              <div ref={resultsRef} style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 32 }}>

                {/* Meta bar */}
                {searchResult.time_ms > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {searchResult.pro_search && (
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
                    {searchResult.intent && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500,
                        background: 'var(--bg-tertiary)', color: 'var(--scarlet)',
                        border: '1px solid var(--border)',
                      }}>
                        {searchResult.intent}
                      </span>
                    )}
                    {/* Engine badges */}
                    {searchResult.engines.map(e => (
                      <span key={e} style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500,
                        background: 'var(--bg-tertiary)', color: ENGINE_COLORS[e] || 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}>
                        {e}
                      </span>
                    ))}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {searchResult.search_count} sources &middot; {searchResult.passages_used} passages &middot; {searchResult.time_ms}ms
                    </span>
                  </div>
                )}

                {/* Answer card */}
                {searchResult.answer && (
                  <div style={{
                    padding: 18, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    lineHeight: 1.7, fontSize: 14,
                  }}>
                    <MarkdownRenderer text={searchResult.answer} onCiteClick={scrollToSource} />
                  </div>
                )}

                {/* Skeleton */}
                {searching && !searchResult.answer && (
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
                {searchResult.citations.length > 0 && (
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
                      Sources ({searchResult.citations.length})
                    </h3>
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                      gap: 6,
                    }}>
                      {searchResult.citations.map(c => {
                        let host = c.url
                        try { host = new URL(c.url).hostname.replace('www.', '') } catch {}
                        return (
                          <a key={c.index} id={`huntr-source-${c.index}`}
                            href={c.url} target="_blank" rel="noopener noreferrer"
                            style={{
                              display: 'flex', gap: 8, padding: 8, borderRadius: 8,
                              background: 'var(--bg-primary)', border: '1px solid var(--border)',
                              textDecoration: 'none', color: 'inherit',
                              transition: 'border-color 0.15s',
                            }}
                            onMouseOver={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--scarlet)'}
                            onMouseOut={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
                          >
                            <div style={{
                              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 10, fontWeight: 700,
                              background: 'var(--scarlet)', color: '#fff',
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
                {searchResult.related_questions.length > 0 && (
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
                      {searchResult.related_questions.map((q, i) => (
                        <button key={i}
                          onClick={() => { setSearchQuery(q); doSearch(q) }}
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
            width: 240, borderLeft: '1px solid var(--border)',
            background: 'var(--bg-secondary)', overflow: 'auto',
            padding: 10, flexShrink: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Historique</h3>
              {history.length > 0 && (
                <button onClick={() => { fetch(`${API}/history`, { method: 'DELETE' }); setHistory([]) }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10 }}>
                  Effacer
                </button>
              )}
            </div>
            {history.length === 0 ? (
              <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>Aucune recherche recente</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {history.map((h, i) => (
                  <button key={i}
                    onClick={() => { setSearchQuery(h.query); setFocus(h.focus || 'web'); doSearch(h.query) }}
                    style={{
                      padding: '7px 8px', borderRadius: 6, fontSize: 11,
                      background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                      border: '1px solid transparent', cursor: 'pointer',
                      textAlign: 'left', lineHeight: 1.3,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    onMouseOver={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
                    onMouseOut={e => (e.currentTarget as HTMLElement).style.borderColor = 'transparent'}
                  >
                    {h.query}
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 5, alignItems: 'center' }}>
                      <span>{h.sources_count} sources</span>
                      {h.mode === 'pro' && <span style={{ color: 'var(--amber, #f59e0b)' }}>Pro</span>}
                      {h.focus && h.focus !== 'web' && (
                        <span style={{ color: 'var(--scarlet)' }}>{h.focus}</span>
                      )}
                      <span>{formatTimeAgo(h.timestamp)}</span>
                    </div>
                  </button>
                ))}
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


// ── Markdown Renderer ──────────────────────────────────────────────────────

function MarkdownRenderer({ text, onCiteClick }: { text: string; onCiteClick?: (idx: number) => void }) {
  if (!text) return null

  const lines = text.split('\n')
  const elements: JSX.Element[] = []
  let key = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('### ')) {
      elements.push(<h4 key={key++} style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 4px', color: 'var(--text-primary)' }}>{processInline(line.slice(4), key, onCiteClick)}</h4>)
    } else if (line.startsWith('## ')) {
      elements.push(<h3 key={key++} style={{ fontSize: 15, fontWeight: 700, margin: '14px 0 4px', color: 'var(--text-primary)' }}>{processInline(line.slice(3), key, onCiteClick)}</h3>)
    } else if (line.startsWith('# ')) {
      elements.push(<h2 key={key++} style={{ fontSize: 16, fontWeight: 700, margin: '16px 0 6px', color: 'var(--text-primary)' }}>{processInline(line.slice(2), key, onCiteClick)}</h2>)
    } else if (/^[-*]\s/.test(line)) {
      elements.push(
        <div key={key++} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 8 }}>
          <span style={{ color: 'var(--scarlet)', flexShrink: 0 }}>&#8226;</span>
          <span style={{ color: 'var(--text-secondary)' }}>{processInline(line.slice(2), key, onCiteClick)}</span>
        </div>
      )
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)/)
      if (match) {
        elements.push(
          <div key={key++} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 8 }}>
            <span style={{ color: 'var(--scarlet)', flexShrink: 0, fontWeight: 600, fontSize: 12 }}>{match[1]}.</span>
            <span style={{ color: 'var(--text-secondary)' }}>{processInline(match[2], key, onCiteClick)}</span>
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
      elements.push(<p key={key++} style={{ margin: '2px 0', color: 'var(--text-secondary)' }}>{processInline(line, key, onCiteClick)}</p>)
    }
  }

  return <>{elements}</>
}


function processInline(text: string, baseKey: number, onCiteClick?: (idx: number) => void): (string | JSX.Element)[] {
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
      parts.push(
        <button key={key} onClick={() => onCiteClick?.(idx)}
          title={`Source ${idx}`}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: '50%', fontSize: 9, fontWeight: 700,
            background: 'var(--scarlet)', color: '#fff',
            border: 'none', cursor: 'pointer', verticalAlign: 'super', margin: '0 1px',
          }}
        >
          {idx}
        </button>
      )
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
