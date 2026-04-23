import { useState, useEffect, useCallback, useRef } from 'react'
import type { CodingPersona, ProviderInfo, AISession, AgentStep } from '../types'
import { API, apiFetch, extractCodeBlocks, PC } from '../utils'
import { PROVIDERS_UPDATED_EVENT } from './SettingsPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// AI PANEL — Model switching, context reduction, sessions, token tracking
// Redesigned: intuitive layout, ScarletWolf charte graphique
// ═══════════════════════════════════════════════════════════════════════════════

const SPEAR_FAV_KEY = 'spearcode_favorite_models'  // Independent from main chat favorites
const SPEAR_MODEL_KEY = 'spearcode_model'
const SPEAR_SESSIONS_KEY = 'spearcode_ai_sessions'
const CTX_MODES = [
  { id: 'smart', label: 'Smart', icon: '⚡', desc: 'Extrait les parties pertinentes du fichier', color: '#22c55e' },
  { id: 'selection', label: 'Selection', icon: '\u{1F3AF}', desc: 'Code selectionne uniquement', color: '#3b82f6' },
  { id: 'full', label: 'Complet', icon: '\u{1F4C4}', desc: 'Fichier entier', color: '#f59e0b' },
  { id: 'none', label: 'Sans', icon: '\u{1F6AB}', desc: 'Pas de contexte fichier', color: '#6b7280' },
] as const

export function AIPanel({ filePath, language, onApplyCode, openFiles = [] }: { filePath?: string; language?: string; onApplyCode: (code: string) => void; openFiles?: Array<{ path: string; name: string; language: string }> }) {
  const [personas, setPersonas] = useState<CodingPersona[]>([])
  const [activePersona, setActivePersona] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [tokenStats, setTokenStats] = useState({ context: 0, total: 0, msgs: 0 })
  const [streamingText, setStreamingText] = useState('')
  // Mode hardcodé sur `agent` — seul le flux agent (avec outils) est
  // désormais exposé ; le bouton Chat a été retiré de l'UI. Le state reste
  // pour éviter de toucher aux rendus conditionnels existants (placeholder,
  // couleur send, icône, affichage agentSteps).
  const [mode, setMode] = useState<'chat' | 'agent'>('agent')
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  const [agentRunning, setAgentRunning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Sessions
  const [sessions, setSessions] = useState<AISession[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SPEAR_SESSIONS_KEY) || '[]')
      return saved.length > 0 ? saved : [{ id: '1', name: 'Session 1', messages: [], tokens: 0 }]
    } catch { return [{ id: '1', name: 'Session 1', messages: [], tokens: 0 }] }
  })
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id || '1')
  const nextSessionId = useRef(sessions.length + 1)
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0]
  const messages = activeSession?.messages || []

  const updateSession = useCallback((fn: (s: AISession) => AISession) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === activeSessionId ? fn(s) : s)
      localStorage.setItem(SPEAR_SESSIONS_KEY, JSON.stringify(next))
      return next
    })
  }, [activeSessionId])

  // Model selection
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(SPEAR_FAV_KEY) || '[]') } catch { return [] }
  })

  // Refresh models for a specific provider (or all)
  const refreshModels = async (providerName?: string) => {
    setLoadingModels(true)
    try {
      if (providerName) {
        const d = await apiFetch<{ provider: string; models: string[] }>(`/providers/${providerName}/models`)
        if (d?.models) {
          setProviders(prev => prev.map(p => p.name === providerName ? { ...p, models: d.models } : p))
        }
      } else {
        const d = await apiFetch<{ providers: ProviderInfo[] }>('/providers')
        if (d?.providers) setProviders(d.providers)
      }
    } catch { /* ignore */ }
    setLoadingModels(false)
  }

  // Context reduction — `smart` par défaut, les autres modes ont été retirés
  // de l'UI (peu utilisés et prêtent à confusion). State conservé pour
  // payload API identique.
  const [contextMode] = useState<'smart' | 'selection' | 'full' | 'none'>('smart')
  const [multiFileCtx, setMultiFileCtx] = useState(false)
  const [hasProjectRules, setHasProjectRules] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Check for .spearcode rules
  useEffect(() => {
    apiFetch<{ ok: boolean; exists: boolean }>('/project-rules').then(d => { if (d) setHasProjectRules(d.exists) })
  }, [])

  // Listen for code action results
  useEffect(() => {
    const handleActionResult = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.response) {
        updateSession(s => ({
          ...s,
          messages: [...s.messages,
            { role: 'user', content: `[Action IA: ${detail.action}]` },
            { role: 'assistant', content: detail.response },
          ],
        }))
      }
    }
    const handleSetAgent = () => setMode('agent')
    const handleExport = () => {
      const md = messages.map(m => `### ${m.role === 'user' ? 'Vous' : 'SpearCode'}\n\n${m.content}\n`).join('\n---\n\n')
      const blob = new Blob([`# SpearCode Session\n\nDate: ${new Date().toLocaleString('fr-FR')}\n\n---\n\n${md}`], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `spearcode_session_${Date.now()}.md`; a.click()
      URL.revokeObjectURL(url)
    }
    window.addEventListener('spearcode-action-result', handleActionResult)
    window.addEventListener('spearcode-set-agent', handleSetAgent)
    window.addEventListener('spearcode-export-session', handleExport)
    return () => {
      window.removeEventListener('spearcode-action-result', handleActionResult)
      window.removeEventListener('spearcode-set-agent', handleSetAgent)
      window.removeEventListener('spearcode-export-session', handleExport)
    }
  }, [messages, updateSession])

  // Load saved model preference
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SPEAR_MODEL_KEY) || '{}')
      if (saved.provider) setSelectedProvider(saved.provider)
      if (saved.model) setSelectedModel(saved.model)
    } catch { /* ignore */ }
  }, [])

  // Load providers & personas (+ re-fetch when the Settings panel adds/removes a key)
  useEffect(() => {
    apiFetch<{ personas: CodingPersona[] }>('/personas').then(d => d && setPersonas(d.personas))
    const loadProviders = () => {
      apiFetch<{ providers: ProviderInfo[] }>('/providers').then(d => {
        if (d?.providers) {
          setProviders(d.providers)
          if (!selectedProvider && d.providers.length > 0) {
            setSelectedProvider(d.providers[0].name)
            setSelectedModel(d.providers[0].default_model)
          }
        }
      })
    }
    loadProviders()
    window.addEventListener(PROVIDERS_UPDATED_EVENT, loadProviders)
    return () => window.removeEventListener(PROVIDERS_UPDATED_EVENT, loadProviders)
  }, [])

  const selectModel = (provName: string, model: string) => {
    setSelectedProvider(provName)
    setSelectedModel(model)
    setShowModelMenu(false)
    setModelSearch('')
    localStorage.setItem(SPEAR_MODEL_KEY, JSON.stringify({ provider: provName, model }))
  }

  const toggleFavorite = (provName: string, model: string) => {
    const key = `${provName}::${model}`
    setFavorites(prev => {
      const next = prev.includes(key) ? prev.filter(f => f !== key) : prev.length >= 8 ? prev : [...prev, key]
      localStorage.setItem(SPEAR_FAV_KEY, JSON.stringify(next))
      return next
    })
  }

  // Session management
  const newSession = () => {
    const id = String(nextSessionId.current++)
    const s: AISession = { id, name: `Session ${id}`, messages: [], tokens: 0 }
    setSessions(prev => {
      const next = [...prev, s]
      localStorage.setItem(SPEAR_SESSIONS_KEY, JSON.stringify(next))
      return next
    })
    setActiveSessionId(id)
    setTokenStats({ context: 0, total: 0, msgs: 0 })
  }

  const compactSession = () => {
    // Compact: summarize context, keep last 2 messages, start fresh-ish
    if (messages.length < 4) return
    const summary = `[Session compactee — ${messages.length} messages, ~${activeSession.tokens} tokens]\nDernier sujet: ${messages[messages.length - 2]?.content.substring(0, 100)}...`
    updateSession(s => ({
      ...s,
      messages: [
        { role: 'assistant', content: summary },
        ...s.messages.slice(-2),
      ],
      tokens: Math.round(s.tokens * 0.2),
    }))
    setTokenStats(prev => ({ ...prev, total: Math.round(prev.total * 0.2) }))
  }

  const closeSession = (id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length === 0) next.push({ id: '1', name: 'Session 1', messages: [], tokens: 0 })
      if (activeSessionId === id) setActiveSessionId(next[next.length - 1].id)
      localStorage.setItem(SPEAR_SESSIONS_KEY, JSON.stringify(next))
      return next
    })
  }

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
      setLoading(false)
      setAgentRunning(false)
      setStreamingText('')
      setAgentSteps([])
      updateSession(s => ({ ...s, messages: [...s.messages, { role: 'assistant', content: '[Generation arretee]' }] }))
    }
  }, [updateSession])

  // ── Streaming send (SSE) ────────────────────────────────────────────────
  const send = async () => {
    if (!input.trim() || loading) return
    const msg = input.trim()
    updateSession(s => ({ ...s, messages: [...s.messages, { role: 'user', content: msg }] }))
    setInput(''); setLoading(true); setStreamingText('')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/ai/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          file_path: filePath || null,
          persona: activePersona,
          provider_name: selectedProvider || undefined,
          model_name: selectedModel || undefined,
          context_mode: contextMode,
          history: messages.slice(-8).map(m => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No stream reader')
      const decoder = new TextDecoder()
      let buffer = ''
      let fullText = ''
      let actionsHeader = ''
      let totalTokens = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'token') {
              fullText += event.content
              setStreamingText(actionsHeader + fullText)
              requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
            } else if (event.type === 'action') {
              const target = event.args?.path || event.args?.src || event.args?.dst || ''
              const label = event.result?.ok ? 'OK' : `ERR: ${event.result?.error || 'echec'}`
              actionsHeader += `• ${event.tool}${target ? ` (${target})` : ''} → ${label}\n`
              setStreamingText(actionsHeader + fullText)
              requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
            } else if (event.type === 'done') {
              fullText = event.full_text || fullText
              totalTokens = event.token_estimate || 0
            } else if (event.type === 'error') {
              fullText = `Erreur: ${event.error}`
            }
          } catch { /* skip malformed */ }
        }
      }
      if (actionsHeader) fullText = actionsHeader + (fullText ? '\n' + fullText : '')

      setStreamingText('')
      updateSession(s => ({
        ...s,
        messages: [...s.messages, { role: 'assistant', content: fullText }],
        tokens: s.tokens + (typeof totalTokens === 'number' ? totalTokens : 0),
      }))

      if (totalTokens && typeof totalTokens === 'object') {
        setTokenStats(prev => ({
          context: (totalTokens as any).context || prev.context,
          total: prev.total + ((totalTokens as any).total || 0),
          msgs: prev.msgs + 2,
        }))
      }
    } catch (err: any) {
      setStreamingText('')
      if (err.name !== 'AbortError') {
        updateSession(s => ({ ...s, messages: [...s.messages, { role: 'assistant', content: `Erreur: ${err.message}` }] }))
      }
    } finally {
      abortRef.current = null
      setLoading(false)
      setStreamingText('')
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
    }
  }

  // ── Agent mode ────────────────────────────────────────────────────────────
  const runAgent = async () => {
    if (!input.trim() || agentRunning) return
    const task = input.trim()
    setInput(''); setAgentRunning(true); setAgentSteps([])
    updateSession(s => ({ ...s, messages: [...s.messages, { role: 'user', content: `🤖 Agent: ${task}` }] }))

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/ai/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          file_path: filePath || null,
          provider_name: selectedProvider || undefined,
          model_name: selectedModel || undefined,
          max_steps: 10,
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No stream reader')
      const decoder = new TextDecoder()
      let buffer = ''
      let finalResponse = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'thinking') {
              setAgentSteps(prev => [...prev, { type: 'thinking', step: event.step }])
            } else if (event.type === 'tool_call') {
              setAgentSteps(prev => [...prev, { type: 'tool_call', step: event.step, tool: event.tool, args: event.args, reasoning: event.reasoning }])
            } else if (event.type === 'tool_result') {
              setAgentSteps(prev => [...prev, { type: 'tool_result', step: event.step, tool: event.tool, result: event.result }])
            } else if (event.type === 'response') {
              finalResponse = event.content || ''
              setAgentSteps(prev => [...prev, { type: 'response', step: event.step, content: event.content }])
            } else if (event.type === 'error') {
              setAgentSteps(prev => [...prev, { type: 'error', step: event.step || 0, error: event.error }])
            }
            requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
          } catch { /* skip */ }
        }
      }

      if (finalResponse) {
        updateSession(s => ({ ...s, messages: [...s.messages, { role: 'assistant', content: finalResponse }] }))
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setAgentSteps(prev => [...prev, { type: 'error', step: 0, error: err.message }])
      }
    } finally {
      abortRef.current = null
      setAgentRunning(false)
      setAgentSteps([])
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
    }
  }

  const modelShort = selectedModel ? selectedModel.split('/').pop()?.substring(0, 22) || selectedModel : 'defaut'
  const curCtx = CTX_MODES.find(m => m.id === contextMode)!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Header: Model + Context ─────────────────────────────── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
        {/* Model selector row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, position: 'relative' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Modele</span>
          <button onClick={() => setShowModelMenu(!showModelMenu)} title="Changer de modele IA"
            style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', fontSize: 10, fontWeight: 600,
              transition: 'border-color 0.15s',
            }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--scarlet)', flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{modelShort}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{selectedProvider || 'auto'}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>

          {/* Model dropdown */}
          {showModelMenu && (
            <div onClick={() => setShowModelMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
          )}
          {showModelMenu && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4,
              maxHeight: 360, background: 'var(--bg-secondary)', borderRadius: 10,
              border: '1px solid var(--border)', overflow: 'hidden', boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="Rechercher un modele..."
                  autoFocus style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 11 }} />
                <button onClick={() => refreshModels()} title="Rafraichir les modeles depuis les providers"
                  disabled={loadingModels}
                  style={{ background: 'none', border: 'none', cursor: loadingModels ? 'wait' : 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={loadingModels ? 'var(--scarlet)' : 'var(--text-muted)'} strokeWidth="2"
                    style={{ animation: loadingModels ? 'spin 1s linear infinite' : 'none' }}>
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                  </svg>
                </button>
              </div>

              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                {/* SpearCode favorites */}
                {!modelSearch && favorites.length > 0 && <>
                  <div style={{ padding: '6px 10px 3px', fontSize: 10, fontWeight: 700, color: 'var(--scarlet)', textTransform: 'uppercase', letterSpacing: 0.5 }}>★ Favoris SpearCode</div>
                  {favorites.map(fav => {
                    const [prov, ...mParts] = fav.split('::')
                    const model = mParts.join('::')
                    const shortName = model.split('/').pop() || model
                    return (
                      <ModelRow key={fav} provider={prov} model={model} shortName={shortName}
                        isActive={selectedProvider === prov && selectedModel === model}
                        isFav={true} onSelect={() => selectModel(prov, model)}
                        onToggleFav={() => toggleFavorite(prov, model)} />
                    )
                  })}
                  <div style={{ borderBottom: '1px solid var(--border)', margin: '4px 0' }} />
                </>}

                {/* Provider groups */}
                {providers.map(prov => {
                  const models = prov.models.length > 0 ? prov.models : [prov.default_model]
                  const filtered = modelSearch
                    ? models.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase()))
                    : models
                  if (filtered.length === 0) return null
                  const displayLimit = modelSearch ? 50 : 20
                  return (
                    <div key={prov.name}>
                      <div style={{ padding: '6px 10px 3px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>{prov.name}</span>
                        <span style={{ fontWeight: 400, opacity: 0.6 }}>{filtered.length}{filtered.length < models.length ? `/${models.length}` : ''} modeles</span>
                      </div>
                      {filtered.slice(0, displayLimit).map(m => {
                        const shortName = m.split('/').pop() || m
                        const favKey = `${prov.name}::${m}`
                        return (
                          <ModelRow key={m} provider={prov.name} model={m} shortName={shortName}
                            isActive={selectedProvider === prov.name && selectedModel === m}
                            isFav={favorites.includes(favKey)} onSelect={() => selectModel(prov.name, m)}
                            onToggleFav={() => toggleFavorite(prov.name, m)} />
                        )
                      })}
                      {filtered.length > displayLimit && (
                        <div style={{ padding: '4px 10px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          ... et {filtered.length - displayLimit} autres (utilisez la recherche)
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Skill dropdown + tokens — Chat/Agent toggle retiré (inutile : un
            seul flux vers le LLM), CTX modes retirés (smart par défaut). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <SkillDropdown
            personas={personas}
            activeId={activePersona}
            onSelect={id => setActivePersona(id)}
          />
          <div style={{ flex: 1 }} />
          {tokenStats.total > 0 && (
            <span title={`Contexte: ~${tokenStats.context} | Session: ~${tokenStats.total}`}
              style={{ fontSize: 10, color: tokenStats.total > 5000 ? '#f59e0b' : '#22c55e', fontWeight: 600, cursor: 'help' }}>
              ~{tokenStats.total > 1000 ? `${(tokenStats.total / 1000).toFixed(1)}k` : tokenStats.total} tok
            </span>
          )}
        </div>
      </div>

      {/* ── Session tabs ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0, overflow: 'auto' }}>
        {sessions.map(s => (
          <div key={s.id} onClick={() => { setActiveSessionId(s.id); setTokenStats(prev => ({ ...prev, total: s.tokens })) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', cursor: 'pointer', fontSize: 11,
              color: s.id === activeSessionId ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: s.id === activeSessionId ? '2px solid var(--scarlet)' : '2px solid transparent',
              fontWeight: s.id === activeSessionId ? 600 : 400,
            }}>
            <span>{s.name}</span>
            <span style={{ fontSize: 11, opacity: 0.4 }}>{s.messages.length > 0 ? `(${s.messages.length})` : ''}</span>
            {sessions.length > 1 && (
              <button onClick={e => { e.stopPropagation(); closeSession(s.id) }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, padding: 0, opacity: 0.3 }}>&times;</button>
            )}
          </div>
        ))}
        <button onClick={newSession} title="Nouvelle session" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: '3px 6px' }}>+</button>
        <div style={{ flex: 1 }} />
        {messages.length >= 4 && (
          <button onClick={compactSession} title="Compacter la session (reduire les tokens)" style={{
            border: 'none', cursor: 'pointer', padding: '2px 6px', marginRight: 4,
            borderRadius: 3, fontSize: 10, fontWeight: 600,
            background: '#6366f120', color: '#6366f1',
          }}>{'\u{1F5DC}️'} Compacter</button>
        )}
      </div>

      {/* ── File indicator + controls ─────────────────────────────── */}
      <div style={{ padding: '2px 10px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {filePath
          ? <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: curCtx.color }} />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 11 }}>{filePath.split('/').pop()}</span>
              <span style={{ fontSize: 11, color: curCtx.color }}>{curCtx.label}</span>
            </span>
          : <span style={{ opacity: 0.4 }}>Aucun fichier ouvert</span>
        }
        {openFiles.length > 1 && (
          <button onClick={() => setMultiFileCtx(!multiFileCtx)} title={multiFileCtx ? 'Multi-fichiers ON' : 'Multi-fichiers OFF'}
            style={{ border: 'none', cursor: 'pointer', borderRadius: 3, padding: '0 4px', fontSize: 11, fontWeight: 700, background: multiFileCtx ? '#3b82f620' : 'transparent', color: multiFileCtx ? '#3b82f6' : 'var(--text-muted)' }}>
            {'\u{1F4C1}'}{openFiles.length}
          </button>
        )}
        {hasProjectRules && <span title="Regles .spearcode actives" style={{ fontSize: 11, color: '#22c55e', fontWeight: 700 }}>{'⚙️'}.spearcode</span>}
        <div style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button onClick={() => window.dispatchEvent(new CustomEvent('spearcode-export-session'))} title="Exporter la session en Markdown" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, opacity: 0.4 }}>{'\u{1F4E4}'}</button>
        )}
        {messages.length > 0 && <button onClick={() => { updateSession(s => ({ ...s, messages: [], tokens: 0 })); setTokenStats({ context: 0, total: 0, msgs: 0 }) }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, opacity: 0.4 }}>Effacer</button>}
      </div>

      {/* ── Messages ─────────────────────────────────────────────── */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {messages.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', lineHeight: 2 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={mode === 'agent' ? '#8b5cf6' : 'var(--scarlet)'} strokeWidth="1.5" style={{ marginBottom: 8, opacity: 0.5 }}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              {mode === 'agent' ? '\u{1F916} SpearCode Agent' : 'SpearCode IA'}
            </div>
            <div style={{ fontSize: 10, opacity: 0.6 }}>
              {mode === 'agent'
                ? <>Decrivez une tache complexe.<br />L'agent planifie, execute et itere automatiquement.</>
                : <>Posez une question sur votre code.<br />Contexte <strong style={{ color: curCtx.color }}>{curCtx.label}</strong> actif. Reponses en streaming.</>
              }
            </div>
          </div>
        ) : messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 8, background: m.role === 'user' ? 'var(--bg-tertiary)' : 'var(--bg-card)', border: m.role === 'assistant' ? '1px solid var(--border)' : 'none' }}>
            <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3, color: m.role === 'user' ? 'var(--scarlet)' : (PC[activePersona || ''] || '#22c55e') }}>
              {m.role === 'user' ? 'Vous' : (personas.find(p => p.id === activePersona)?.name || 'SpearCode')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
            {m.role === 'assistant' && extractCodeBlocks(m.content).length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {extractCodeBlocks(m.content).map((block, bi) => (
                  <button key={bi} onClick={() => onApplyCode(block.code)}
                    style={{ border: 'none', cursor: 'pointer', borderRadius: 4, padding: '3px 8px', fontSize: 10, fontWeight: 600, background: '#22c55e20', color: '#22c55e', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    Appliquer {block.language ? `(${block.language})` : `bloc ${bi + 1}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {/* Streaming text (live tokens) */}
        {loading && streamingText && (
          <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3, color: PC[activePersona || ''] || '#22c55e' }}>
              {personas.find(p => p.id === activePersona)?.name || 'SpearCode'} <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>streaming...</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{streamingText}<span style={{ display: 'inline-block', width: 5, height: 12, background: 'var(--scarlet)', marginLeft: 1, animation: 'pulse 0.6s ease-in-out infinite' }} /></div>
          </div>
        )}
        {/* Agent steps live display */}
        {agentRunning && agentSteps.length > 0 && (
          <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 8, background: '#8b5cf608', border: '1px solid #8b5cf630' }}>
            <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3, color: '#8b5cf6', display: 'flex', alignItems: 'center', gap: 4 }}>
              {'\u{1F916}'} Agent Mode <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>etape {agentSteps[agentSteps.length - 1]?.step || '...'}</span>
            </div>
            {agentSteps.map((s, i) => (
              <div key={i} style={{ marginBottom: 4, fontSize: 10, lineHeight: 1.5 }}>
                {s.type === 'thinking' && (
                  <div style={{ color: '#8b5cf6', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#8b5cf6', animation: 'pulse 1s ease-in-out infinite' }} />
                    Etape {s.step}: Reflexion...
                  </div>
                )}
                {s.type === 'tool_call' && (
                  <div style={{ background: '#1e293b', borderRadius: 6, padding: '4px 8px', border: '1px solid #334155' }}>
                    <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 11 }}>{'\u{1F527}'} {s.tool}({Object.keys(s.args || {}).map(k => `${k}="${String(s.args[k]).substring(0, 30)}"`).join(', ')})</div>
                    {s.reasoning && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>{s.reasoning.substring(0, 120)}</div>}
                  </div>
                )}
                {s.type === 'tool_result' && (
                  <div style={{ background: '#0f172a', borderRadius: 6, padding: '4px 8px', border: '1px solid #1e293b', maxHeight: 80, overflow: 'auto' }}>
                    <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 10 }}>{'✅'} Resultat de {s.tool}</div>
                    <pre style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{(s.result || '').substring(0, 300)}</pre>
                  </div>
                )}
                {s.type === 'response' && (
                  <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>{s.content}</div>
                )}
                {s.type === 'error' && (
                  <div style={{ color: '#dc2626', fontWeight: 600 }}>{'❌'} Erreur: {s.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {(loading || agentRunning) && !streamingText && !agentRunning && (
          <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--scarlet)', animation: 'pulse 1s ease-in-out infinite' }} />
              Connexion...
            </div>
          </div>
        )}
        {(loading || agentRunning) && (
          <div style={{ padding: '4px 10px', display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={stopGeneration} title="Arreter" style={{
              border: 'none', cursor: 'pointer', padding: '3px 10px', borderRadius: 4,
              background: '#dc262620', color: '#dc2626', fontSize: 11, fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              Stop
            </button>
          </div>
        )}
      </div>

      {/* ── Input ─────────────────────────────────────────────────── */}
      <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {mode === 'agent' && (
          <div style={{ fontSize: 10, color: '#8b5cf6', fontWeight: 600, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
            {'\u{1F916}'} Mode Agent — l'IA va planifier et executer les etapes automatiquement
          </div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <textarea value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mode === 'agent' ? runAgent() : send() } }}
            placeholder={mode === 'agent' ? 'Decrivez la tache a automatiser...' : 'Demandez a SpearCode...'}
            disabled={loading || agentRunning} rows={2}
            style={{
              flex: 1, resize: 'none', padding: '6px 10px', borderRadius: 8,
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 11,
              outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
              border: mode === 'agent' ? '1px solid #8b5cf640' : '1px solid var(--border)',
            }} />
          <button
            onClick={(loading || agentRunning) ? stopGeneration : (mode === 'agent' ? runAgent : send)}
            disabled={!(loading || agentRunning) && !input.trim()}
            title={(loading || agentRunning) ? 'Arreter' : mode === 'agent' ? 'Lancer l\'agent' : 'Envoyer'}
            style={{
              alignSelf: 'flex-end', width: 32, height: 32, borderRadius: 8, border: 'none',
              background: (loading || agentRunning) ? '#dc2626' : input.trim() ? (mode === 'agent' ? '#8b5cf6' : 'var(--scarlet)') : 'var(--bg-tertiary)',
              color: (loading || agentRunning) || input.trim() ? '#fff' : 'var(--text-muted)',
              cursor: (loading || agentRunning) || input.trim() ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}>
            {(loading || agentRunning)
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              : mode === 'agent'
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

export function ModelRow({ provider, model, shortName, isActive, isFav, onSelect, onToggleFav }: {
  provider: string; model: string; shortName: string; isActive: boolean; isFav: boolean
  onSelect: () => void; onToggleFav: () => void
}) {
  void provider; void model
  const [hovered, setHovered] = useState(false)
  return (
    <div onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 10,
        background: isActive ? 'var(--bg-tertiary)' : hovered ? 'var(--bg-tertiary)' : 'transparent',
        borderLeft: isActive ? '2px solid var(--scarlet)' : '2px solid transparent',
        transition: 'background 0.08s',
      }}>
      <button onClick={e => { e.stopPropagation(); onToggleFav() }} title={isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11,
          color: isFav ? '#f59e0b' : 'var(--text-muted)', opacity: isFav ? 1 : hovered ? 0.5 : 0.15,
          transition: 'opacity 0.1s',
        }}>{isFav ? '★' : '☆'}</button>
      <span style={{ flex: 1, color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: isActive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName}</span>
      {isActive && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--scarlet)' }} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillDropdown — regroupe les personas (Architect, Debugger, Reviewer, etc.)
// sous un bouton unique avec menu déroulant. Remplace l'ancienne rangée de
// badges qui prenait toute la largeur.
// ─────────────────────────────────────────────────────────────────────────────

function SkillDropdown({ personas, activeId, onSelect }: {
  personas: CodingPersona[]
  activeId: string | null
  onSelect: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const active = personas.find(p => p.id === activeId) || null
  const color = active ? (PC[active.id] || 'var(--scarlet)') : 'var(--text-muted)'

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button onClick={() => setOpen(v => !v)} onBlur={() => setTimeout(() => setOpen(false), 180)}
        title="Choisir un rôle (skill) pour cette session"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
          background: active ? `${color}20` : 'var(--bg-tertiary)',
          border: active ? `1px solid ${color}40` : '1px solid var(--border)',
          color: active ? color : 'var(--text-secondary)',
          fontSize: 10, fontWeight: 600,
        }}>
        <span style={{ fontSize: 11 }}>{active ? active.icon : '🎭'}</span>
        <span>{active ? active.name : 'Skill'}</span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0,
          minWidth: 180, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: 6, boxShadow: '0 8px 18px rgba(0,0,0,0.3)',
          padding: 3, zIndex: 20, maxHeight: 260, overflowY: 'auto',
        }}>
          {/* Option pour désactiver le skill courant */}
          <button onMouseDown={e => { e.preventDefault(); onSelect(null); setOpen(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%',
              padding: '5px 8px', borderRadius: 4, background: 'transparent',
              border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10,
              textAlign: 'left',
            }}>
            <span style={{ fontSize: 11, width: 16, textAlign: 'center' }}>∅</span>
            <span>Aucun skill</span>
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '2px 0' }} />
          {personas.map(p => {
            const c = PC[p.id] || 'var(--text-muted)'
            const isActive = p.id === activeId
            return (
              <button key={p.id}
                onMouseDown={e => { e.preventDefault(); onSelect(p.id); setOpen(false) }}
                title={p.description}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                  background: isActive ? `${c}15` : 'transparent',
                  color: isActive ? c : 'var(--text-primary)',
                  border: 'none', fontSize: 10, fontWeight: isActive ? 600 : 400,
                  textAlign: 'left',
                }}>
                <span style={{ fontSize: 11, width: 16, textAlign: 'center' }}>{p.icon}</span>
                <span style={{ flex: 1 }}>{p.name}</span>
                {isActive && <span style={{ fontSize: 11, color: c }}>✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
