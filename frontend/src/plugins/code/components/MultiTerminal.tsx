import { useState, useEffect, useRef } from 'react'
import type { TermEntry, TermSession, RunResult } from '../types'
import { API, apiFetch, MONO, S, renderMarkdown } from '../utils'

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-TERMINAL
// ═══════════════════════════════════════════════════════════════════════════════

const TERM_STORAGE_KEY = 'spearcode_terminal'

function loadTermSessions(): { sessions: TermSession[]; active: string; cmdHistory: string[]; nextId: number; aiEnabled?: boolean } | null {
  try {
    const raw = localStorage.getItem(TERM_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    // Strip streaming flags from restored entries
    if (data.sessions) {
      for (const s of data.sessions) {
        if (s.history) s.history = s.history.map((h: TermEntry) => ({ ...h, streaming: false }))
      }
    }
    return data
  } catch { return null }
}

function saveTermSessions(sessions: TermSession[], active: string, cmdHistory: string[], nextId: number, aiEnabled: boolean) {
  try {
    // Cap stored history to keep localStorage lean (last 50 entries per session, last 30 AI messages)
    const compact = sessions.map(s => ({
      ...s,
      history: s.history.slice(-50).map(h => ({ ...h, streaming: false })),
      aiHistory: s.aiHistory.slice(-30),
    }))
    localStorage.setItem(TERM_STORAGE_KEY, JSON.stringify({ sessions: compact, active, cmdHistory: cmdHistory.slice(0, 50), nextId, aiEnabled }))
  } catch {}
}

export function MultiTerminal({ runFile, onClose, filePath }: { runFile?: string; onClose: () => void; filePath?: string }) {
  const savedTerm = useRef(loadTermSessions())
  const [sessions, setSessions] = useState<TermSession[]>(savedTerm.current?.sessions?.length ? savedTerm.current.sessions : [{ id: '1', name: 'Terminal 1', history: [], aiHistory: [] }])
  const [activeSession, setActiveSession] = useState(savedTerm.current?.active || '1')
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [cmdHistory, setCmdHistory] = useState<string[]>(savedTerm.current?.cmdHistory || [])
  const [histIdx, setHistIdx] = useState(-1)
  // Chat IA désactivé par défaut : la console affiche uniquement le shell
  // (actions de l'agent + commandes manuelles). La saisie en langage naturel
  // est disponible derrière un toggle (case à cocher dans l'en-tête).
  const [aiEnabled, setAiEnabled] = useState<boolean>(!!savedTerm.current?.aiEnabled)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(savedTerm.current?.nextId || 2)
  const abortRef = useRef<AbortController | null>(null)
  const session = sessions.find(s => s.id === activeSession) || sessions[0]

  // Persist terminal sessions on every change
  useEffect(() => {
    saveTermSessions(sessions, activeSession, cmdHistory, nextId.current, aiEnabled)
  }, [sessions, activeSession, cmdHistory, aiEnabled])

  const addSession = () => { const id = String(nextId.current++); setSessions(prev => [...prev, { id, name: `Terminal ${id}`, history: [], aiHistory: [] }]); setActiveSession(id) }
  const autoScroll = () => requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
  const closeSession = (id: string) => {
    setSessions(prev => { const next = prev.filter(s => s.id !== id); if (next.length === 0) { onClose(); return prev } if (activeSession === id) setActiveSession(next[next.length - 1].id); return next })
  }

  // Smart detection: shell command vs natural language AI question
  const detectMode = (text: string, lastWasAi?: boolean): 'shell' | 'ai' => {
    const t = text.trim().toLowerCase()
    // Force shell with $ prefix, force AI with ? prefix
    if (t.startsWith('$')) return 'shell'
    if (t.startsWith('?')) return 'ai'
    // Shell indicators: known commands, paths, pipes, redirects
    const shellStarts = /^(ls|cd|dir|pwd|cat|echo|mkdir|rm|mv|cp|touch|chmod|chown|grep|find|sed|awk|curl|wget|tar|zip|unzip|git|npm|npx|yarn|pnpm|pip|python|python3|node|deno|bun|cargo|go|make|cmake|docker|kubectl|ssh|scp|rsync|which|where|type|set|export|env|source|\.|\.\/|\/|~|sudo|apt|brew|choco|winget|powershell|cmd|exit|clear|cls|ping|netstat|ifconfig|ipconfig|whoami|date|time|head|tail|wc|sort|uniq|tr|cut|xargs|tee|diff|patch|man|help|tree)(\s|$)/
    if (shellStarts.test(t)) return 'shell'
    if (/^[.\/~]/.test(t)) return 'shell'
    if (/[|><]/.test(t) && t.split(' ').length <= 6) return 'shell'
    if (/&&|\|\||;/.test(t)) return 'shell'
    // Short conversational replies (oui/non/ok/...) — always AI, even without context,
    // because they never make sense as shell commands.
    const shortReplies = /^(oui|non|yes|no|y|n|ok|okay|d'accord|ouais|nope|yep|yeah|si|peut-etre|peut-être|parfait|super|merci|thanks|stop|continue|applique|applique-le|applique le|valide|valide-le|valide le|confirme|vas-y|vas y|go|fais-le|fais le|fait-le|fait le|oui stp|oui s'il te plait|yes please)([\s.!?,]|$)/i
    if (shortReplies.test(t)) return 'ai'
    // AI indicators: question marks, French question/action words, long sentences
    if (t.endsWith('?')) return 'ai'
    const aiStarts = /^(comment|pourquoi|quoi|quel|quelle|quels|quelles|est-ce|est ce|peux|peut|pouvez|explique|corrige|montre|aide|ajoute|modifie|cree|genere|ecris|refactorise|optimise|analyse|debug|teste|review|fait|fais|dis|donne|liste|compare|traduis|transforme|supprime|renomme|documente|implement|fix|add|create|write|show|help|explain|find me|how|what|why|where|when|can|could|would|should|please|do|make|update|change|remove|delete|build|run me|tell|describe|is there|are there|j'ai|je veux|je voudrais|il faut|on peut|tu peux)/
    if (aiStarts.test(t)) return 'ai'
    // Heuristic: >5 words without shell chars = probably natural language
    const words = t.split(/\s+/).length
    if (words >= 5 && !/[|><;$`]/.test(t)) return 'ai'
    // Context-aware: after an AI turn, short natural-language replies stay AI.
    if (lastWasAi && words <= 4 && !/[|><;$`\\]/.test(t)) return 'ai'
    // Short text with no shell pattern = probably shell
    return 'shell'
  }

  const lastEntryIsAi = (): boolean => {
    const sess = sessions.find(s => s.id === activeSession)
    const last = sess?.history?.[sess.history.length - 1]
    return !!last?.isAI
  }

  const [inputMode, setInputMode] = useState<'shell' | 'ai'>('shell')
  useEffect(() => {
    if (!aiEnabled) { setInputMode('shell'); return }
    setInputMode(command.trim() ? detectMode(command, lastEntryIsAi()) : 'shell')
  }, [command, sessions, activeSession, aiEnabled])

  // Streaming AI chat with conversation history per session
  const runAI = async (question: string) => {
    const currentSession = sessions.find(s => s.id === activeSession)!
    const newAiHistory = [...currentSession.aiHistory, { role: 'user', content: question }]

    // Add streaming entry
    const streamEntry: TermEntry = { cmd: question, result: { ok: true, exit_code: 0, stdout: '', stderr: '', elapsed: 0 }, isAI: true, streaming: true }
    setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [...s.history, streamEntry], aiHistory: newAiHistory } : s))
    autoScroll()

    const controller = new AbortController()
    abortRef.current = controller
    const startTime = Date.now()

    try {
      const res = await fetch(`${API}/ai/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, file_path: filePath || null, context_mode: 'smart', history: newAiHistory.slice(-16) }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) throw new Error('Stream non disponible')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let actionsHeader = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'token') {
              fullText += data.content
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSession) return s
                const hist = [...s.history]
                const last = hist[hist.length - 1]
                if (last?.streaming) hist[hist.length - 1] = { ...last, result: { ...last.result, stdout: actionsHeader + fullText } }
                return { ...s, history: hist }
              }))
              autoScroll()
            } else if (data.type === 'action') {
              const args = data.args || {}
              const target = args.path || args.src || args.dst || ''
              const label = data.result?.ok ? 'OK' : `ERR: ${data.result?.error || 'echec'}`
              actionsHeader += `• ${data.tool}${target ? ` (${target})` : ''} → ${label}\n`
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSession) return s
                const hist = [...s.history]
                const last = hist[hist.length - 1]
                if (last?.streaming) hist[hist.length - 1] = { ...last, result: { ...last.result, stdout: actionsHeader + fullText } }
                return { ...s, history: hist }
              }))
              autoScroll()
            } else if (data.type === 'error') {
              throw new Error(data.error)
            }
          } catch (e: any) { if (e.message && !e.message.includes('JSON')) throw e }
        }
      }
      if (actionsHeader) fullText = actionsHeader + (fullText ? '\n' + fullText : '')

      const elapsed = (Date.now() - startTime) / 1000
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession) return s
        const hist = [...s.history]
        const last = hist[hist.length - 1]
        if (last?.streaming) hist[hist.length - 1] = { ...last, streaming: false, result: { ...last.result, stdout: fullText, elapsed } }
        return { ...s, history: hist, aiHistory: [...s.aiHistory, { role: 'assistant', content: fullText }] }
      }))
    } catch (e: any) {
      if (e.name === 'AbortError') return
      // Plus de fallback vers /ai/chat (endpoint retiré) — on remonte
      // simplement l'erreur de streaming dans l'historique terminal.
      {
        const elapsed = (Date.now() - startTime) / 1000
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSession) return s
          const hist = [...s.history]
          const last = hist[hist.length - 1]
          if (last?.streaming) hist[hist.length - 1] = { ...last, streaming: false, result: { ok: false, exit_code: 1, stdout: '', stderr: e.message || 'Erreur IA', elapsed } }
          return { ...s, history: hist }
        }))
      }
    } finally {
      abortRef.current = null
    }
  }

  const run = async (cmd?: string) => {
    const toRun = cmd || command.trim(); if (!toRun || running) return
    setRunning(true); setCmdHistory(prev => [toRun, ...prev.filter(c => c !== toRun)].slice(0, 50)); setHistIdx(-1)

    // Chat IA off → on force le mode shell (on ignore la détection de langage
    // naturel et les préfixes ?). Chat IA on → détection automatique.
    const mode = aiEnabled ? detectMode(toRun, lastEntryIsAi()) : 'shell'
    const cleanCmd = toRun.startsWith('$') ? toRun.substring(1).trim()
      : (aiEnabled && toRun.startsWith('?')) ? toRun.substring(1).trim()
      : toRun

    if (mode === 'ai') {
      setCommand('')
      await runAI(cleanCmd)
      setRunning(false); autoScroll()
      return
    }

    const res = await apiFetch<RunResult>('/terminal', { method: 'POST', body: JSON.stringify({ command: cleanCmd, timeout: 30 }) })
    if (res) setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [...s.history, { cmd: toRun, result: res }] } : s))
    setCommand(''); setRunning(false); autoScroll()
  }

  const handleRunFile = async () => {
    if (!runFile) return; setRunning(true)
    const res = await apiFetch<RunResult>('/run', { method: 'POST', body: JSON.stringify({ path: runFile, args: [], timeout: 30 }) })
    if (res) setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [...s.history, { cmd: res.command || `run ${runFile}`, result: res }] } : s))
    setRunning(false); autoScroll()
  }

  const clearSession = () => {
    if (abortRef.current) abortRef.current.abort()
    setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [], aiHistory: [] } : s))
  }

  // Render AI response with markdown formatting (content comes from our own LLM, same pattern as renderMarkdown used elsewhere in this file)
  const renderAIBlock = (text: string, isStreaming?: boolean) => {
    const html = renderMarkdown(text || (isStreaming ? '...' : ''))
    return (
      <div style={{ color: '#c9d1d9', margin: '2px 0 4px', padding: '6px 10px', background: '#131820', borderRadius: 6, borderLeft: '3px solid #8b5cf6', fontSize: 11, lineHeight: 1.6 }}>
        {/* eslint-disable-next-line react/no-danger -- LLM-generated markdown rendered via our own renderMarkdown, not user HTML */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {isStreaming && <span style={{ display: 'inline-block', width: 6, height: 14, background: '#8b5cf6', marginLeft: 2, animation: 'termBlink 1s infinite', verticalAlign: 'text-bottom' }} />}
      </div>
    )
  }

  return (
    <div style={{ height: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--scarlet)', background: '#0c0f14' }}>
      <style>{`@keyframes termBlink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } } @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', background: '#131820', borderBottom: '1px solid #1e2633', flexShrink: 0 }}>
        {sessions.map(s => (
          <div key={s.id} onClick={() => setActiveSession(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 10, color: s.id === activeSession ? '#c9d1d9' : '#8b949e', borderBottom: s.id === activeSession ? '2px solid var(--scarlet)' : '2px solid transparent' }}>
            <span>{s.name}</span>
            {s.aiHistory.length > 0 && <span style={{ fontSize: 7, color: '#8b5cf6', fontWeight: 700 }}>{Math.floor(s.aiHistory.length / 2)}</span>}
            {sessions.length > 1 && <button onClick={e => { e.stopPropagation(); closeSession(s.id) }} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 9, padding: 0, opacity: 0.4 }}>&times;</button>}
          </div>
        ))}
        <button onClick={addSession} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 12, padding: '4px 8px' }}>+</button>
        <div style={{ flex: 1 }} />
        {runFile && <button onClick={handleRunFile} disabled={running} style={{ ...S.badge('#22c55e', true), border: 'none', fontSize: 9, marginRight: 4 } as any}>{running ? '...' : `Run ${runFile.split('/').pop()}`}</button>}
        {aiEnabled && session.aiHistory.length > 0 && <span style={{ fontSize: 8, color: '#8b5cf6', marginRight: 8, opacity: 0.7 }}>{Math.floor(session.aiHistory.length / 2)} echanges</span>}
        <button
          onClick={() => setAiEnabled(v => !v)}
          title={aiEnabled ? 'Desactiver le chat IA (retour shell uniquement)' : 'Activer le chat IA (langage naturel + memoire de session)'}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            border: `1px solid ${aiEnabled ? '#8b5cf6' : '#1e2633'}`,
            background: aiEnabled ? 'rgba(139, 92, 246, 0.12)' : 'transparent',
            color: aiEnabled ? '#c4b5fd' : '#8b949e',
            cursor: 'pointer', fontSize: 9, fontWeight: 600,
            padding: '2px 7px', borderRadius: 4, marginRight: 6,
            fontFamily: MONO,
          }}>
          <span style={{
            width: 8, height: 8, borderRadius: 2, flexShrink: 0,
            background: aiEnabled ? '#8b5cf6' : 'transparent',
            border: `1px solid ${aiEnabled ? '#8b5cf6' : '#6b7280'}`,
          }} />
          Chat IA
        </button>
        <button onClick={clearSession} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 9, marginRight: 4 }}>Clear</button>
        <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 11, marginRight: 8 }}>&times;</button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '4px 12px', fontFamily: MONO, fontSize: 11, lineHeight: 1.5 }}>
        {session.history.length === 0 && (
          aiEnabled ? (
            <div style={{ color: '#8b949e', fontSize: 10, padding: '4px 0', lineHeight: 1.8 }}>Terminal hybride conversationnel.<br /><span style={{ color: '#6b7280' }}>Commandes shell executees normalement. Questions en langage naturel = conversation IA avec memoire de session.<br />Prefixez <span style={{ color: 'var(--scarlet)' }}>$</span> pour forcer shell, <span style={{ color: '#8b5cf6' }}>?</span> pour forcer IA. L'IA se souvient du contexte de cette session.</span></div>
          ) : (
            <div style={{ color: '#8b949e', fontSize: 10, padding: '4px 0', lineHeight: 1.8 }}>Terminal shell.<br /><span style={{ color: '#6b7280' }}>Les actions executees par l'agent s'affichent ici. Saisissez une commande pour l'executer.<br />Cochez <span style={{ color: '#8b5cf6' }}>Chat IA</span> pour activer la conversation en langage naturel dans ce terminal.</span></div>
          )
        )}
        {session.history.map((h, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div>
              <span style={{ color: h.isAI ? '#8b5cf6' : 'var(--scarlet)', fontWeight: 700 }}>{h.isAI ? 'IA' : '~'}</span>
              <span style={{ color: '#8b949e' }}>{h.isAI ? ' > ' : ' $ '}</span>
              <span style={{ color: '#c9d1d9' }}>{h.cmd}</span>
            </div>
            {h.isAI ? (
              h.result.stdout ? renderAIBlock(h.result.stdout, h.streaming) :
              h.result.stderr ? <pre style={{ color: '#f85149', margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>{h.result.stderr}</pre> :
              h.streaming ? renderAIBlock('', true) : null
            ) : (
              <>
                {h.result.stdout && <pre style={{ color: '#c9d1d9', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{h.result.stdout}</pre>}
                {h.result.stderr && <pre style={{ color: '#f85149', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{h.result.stderr}</pre>}
                <div style={{ color: '#8b949e', fontSize: 9 }}><span style={{ color: h.result.ok ? '#22c55e' : '#f85149' }}>{h.result.ok ? '✓' : '✗'}</span> exit {h.result.exit_code} &mdash; {h.result.elapsed}s</div>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', borderTop: '1px solid #1e2633', flexShrink: 0 }}>
        <span style={{
          fontFamily: MONO, fontSize: 10, marginRight: 6, fontWeight: 700, minWidth: 20, textAlign: 'center',
          color: inputMode === 'ai' ? '#8b5cf6' : 'var(--scarlet)',
          transition: 'color 0.15s',
        }}>{inputMode === 'ai' ? 'IA' : '~$'}</span>
        <input value={command} onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') run()
            if (e.key === 'Escape' && running && abortRef.current) { abortRef.current.abort(); setRunning(false) }
            if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.min(histIdx + 1, cmdHistory.length - 1); setHistIdx(n); if (cmdHistory[n]) setCommand(cmdHistory[n]) }
            if (e.key === 'ArrowDown') { e.preventDefault(); const n = Math.max(histIdx - 1, -1); setHistIdx(n); setCommand(n >= 0 ? cmdHistory[n] : '') }
          }}
          placeholder={inputMode === 'ai' ? 'Posez votre question... (contexte de session)' : 'Commande...'}
          disabled={running}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#c9d1d9', fontFamily: MONO, fontSize: 11 }} />
        {running && <button onClick={() => { if (abortRef.current) abortRef.current.abort(); setRunning(false) }} style={{ border: 'none', background: 'transparent', color: '#f85149', cursor: 'pointer', fontSize: 9, fontWeight: 700, marginRight: 4 }}>Stop</button>}
        <span style={{ fontSize: 7, fontWeight: 600, color: inputMode === 'ai' ? '#8b5cf6' : '#6b7280', opacity: command.trim() ? 0.8 : 0, transition: 'opacity 0.15s', fontFamily: MONO }}>
          {inputMode === 'ai' ? 'IA' : 'SHELL'}
        </span>
      </div>
    </div>
  )
}
