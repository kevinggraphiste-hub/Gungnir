/**
 * Gungnir Plugin — Chat Vocal Temps Réel
 *
 * Multi-provider : ElevenLabs ConvAI, OpenAI Realtime, Gemini Live, Grok Realtime
 * 100% temps réel — pas de STT/TTS séparé.
 * Plugin indépendant — aucune dépendance core.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Mic, MicOff, Volume2, VolumeX, Radio, Wifi, WifiOff,
  AlertCircle, Loader2, Plus, Settings, ChevronDown,
  Clock, Trash2, MessageSquare, Phone, PhoneOff,
  Sparkles, History, X, Check, RefreshCw,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

type ConvEntry = { role: 'user' | 'assistant'; text: string; ts: number }
type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error'
type SideView = 'none' | 'providers' | 'history' | 'settings'

interface VoiceProvider {
  name: string
  display_name: string
  icon: string
  description: string
  mode: 'direct' | 'relay'
  sample_rate_in: number
  sample_rate_out: number
  enabled: boolean
  has_voice_key: boolean
  has_llm_key: boolean
  has_agent: boolean
  voice_id: string
  language: string
}

interface VoiceSession {
  id: string
  provider: string
  messages: ConvEntry[]
  duration_seconds: number
  created_at: string
  title: string
}

// ── Constants ──────────────────────────────────────────────────────────────

const API = '/api/plugins/voice'

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Prêt — cliquez pour démarrer',
  connecting: 'Connexion en cours…',
  listening: 'En écoute — parlez naturellement',
  speaking: 'L\'assistant parle…',
  error: 'Erreur de connexion',
}

const STATUS_COLOR: Record<VoiceStatus, string> = {
  idle: 'var(--text-muted)',
  connecting: 'var(--accent-tertiary)',
  listening: 'var(--accent-success)',
  speaking: 'var(--accent-primary)',
  error: 'var(--accent-danger)',
}

const PROVIDER_COLORS: Record<string, string> = {
  elevenlabs: '#fbbf24',
  openai: '#22c55e',
  google: '#3b82f6',
  grok: '#a855f7',
}

// ── Plugin Component ───────────────────────────────────────────────────────

export default function VoicePlugin() {
  // State
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [conversation, setConversation] = useState<ConvEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [providers, setProviders] = useState<VoiceProvider[]>([])
  const [activeProvider, setActiveProvider] = useState<string>('elevenlabs')
  const [needsAgent, setNeedsAgent] = useState(false)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [sideView, setSideView] = useState<SideView>('none')
  const [sessions, setSessions] = useState<VoiceSession[]>([])
  const [sessionStart, setSessionStart] = useState<number>(0)
  const [providerDropdown, setProviderDropdown] = useState(false)
  const [testingProvider, setTestingProvider] = useState<string | null>(null)

  // Refs
  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const convEndRef = useRef<HTMLDivElement | null>(null)
  const audioQueueRef = useRef<ArrayBuffer[]>([])
  const isPlayingRef = useRef(false)

  // ── Auto-scroll conversation ─────────────────────────────────────────
  useEffect(() => { convEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [conversation])

  // ── Load providers on mount ──────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/providers`)
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || [])
        // Auto-select first enabled provider
        const enabled = (data.providers || []).find((p: VoiceProvider) => p.enabled)
        if (enabled) setActiveProvider(enabled.name)
      })
      .catch(() => {})

    // Load sessions
    fetch(`${API}/sessions`)
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {})
  }, [])

  // ── Check ElevenLabs agent status ────────────────────────────────────
  useEffect(() => {
    if (activeProvider !== 'elevenlabs') { setNeedsAgent(false); return }
    fetch(`${API}/convai/config`)
      .then(r => r.json())
      .then(data => setNeedsAgent(data.has_api_key && !data.has_agent))
      .catch(() => {})
  }, [activeProvider])

  // ── Cleanup on unmount ───────────────────────────────────────────────
  useEffect(() => { return () => endSession() }, [])

  // ── Audio playback (PCM16 queue) ─────────────────────────────────────
  const playNextAudio = useCallback(() => {
    if (isMuted || audioQueueRef.current.length === 0 || isPlayingRef.current) return
    isPlayingRef.current = true

    const pcmData = audioQueueRef.current.shift()!
    const provider = providers.find(p => p.name === activeProvider)
    const sampleRate = provider?.sample_rate_out || 16000

    const ctx = audioCtxRef.current || new AudioContext({ sampleRate })
    audioCtxRef.current = ctx

    const int16 = new Int16Array(pcmData)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0

    const buffer = ctx.createBuffer(1, float32.length, sampleRate)
    buffer.getChannelData(0).set(float32)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.onended = () => {
      isPlayingRef.current = false
      if (audioQueueRef.current.length > 0) playNextAudio()
      else setStatus(prev => prev === 'speaking' ? 'listening' : prev)
    }
    src.start()
  }, [isMuted, activeProvider, providers])

  // ── Create ElevenLabs agent ──────────────────────────────────────────
  const createAgent = useCallback(async () => {
    setCreatingAgent(true); setError(null)
    try {
      const resp = await fetch(`${API}/convai/create-agent`, { method: 'POST' })
      const data = await resp.json()
      if (data.agent_id) { setNeedsAgent(false) }
      else setError(data.detail || data.error || 'Impossible de créer l\'agent')
    } catch (err: any) { setError(err?.message || 'Erreur réseau') }
    finally { setCreatingAgent(false) }
  }, [])

  // ── Start session (multi-provider) ───────────────────────────────────
  const startSession = useCallback(async () => {
    setError(null); setStatus('connecting'); setConversation([])
    setSessionStart(Date.now())

    try {
      const provider = providers.find(p => p.name === activeProvider)
      if (!provider) { setError('Provider non configuré'); setStatus('error'); return }

      // Get microphone
      const sampleRate = provider.sample_rate_in
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })
      streamRef.current = stream

      let ws: WebSocket

      if (activeProvider === 'elevenlabs') {
        // ElevenLabs: get signed URL, connect directly
        const resp = await fetch(`${API}/convai/signed-url`)
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ detail: 'Erreur' }))
          throw new Error(err.detail || 'Erreur signed URL')
        }
        const data = await resp.json()
        ws = new WebSocket(data.signed_url)
      } else {
        // Built-in or custom: connect via backend relay
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const builtInPaths: Record<string, string> = {
          openai: 'openai/realtime',
          google: 'google/realtime',
          grok: 'grok/realtime',
        }
        const relayPath = builtInPaths[activeProvider] || `custom/${activeProvider}/realtime`
        ws = new WebSocket(`${protocol}//${window.location.host}${API}/${relayPath}`)
      }

      wsRef.current = ws

      ws.onopen = () => {
        setStatus('listening'); setError(null)

        // ElevenLabs ConvAI requires an initiation message before anything else
        if (activeProvider === 'elevenlabs') {
          ws.send(JSON.stringify({
            type: 'conversation_initiation_client_data',
            conversation_config_override: {},
            dynamic_variables: {},
          }))
        }

        // Setup audio capture — browser mic is always at hardware rate (usually 48kHz)
        // We need to resample to the provider's expected rate
        const audioCtx = new AudioContext()
        audioCtxRef.current = audioCtx
        const nativeRate = audioCtx.sampleRate // e.g. 48000
        const source = audioCtx.createMediaStreamSource(stream)
        sourceNodeRef.current = source
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        // Resample function: downsample from nativeRate to targetRate
        const resample = (input: Float32Array, fromRate: number, toRate: number): Float32Array => {
          if (fromRate === toRate) return input
          const ratio = fromRate / toRate
          const outLen = Math.round(input.length / ratio)
          const output = new Float32Array(outLen)
          for (let i = 0; i < outLen; i++) {
            const srcIdx = i * ratio
            const idx = Math.floor(srcIdx)
            const frac = srcIdx - idx
            output[i] = idx + 1 < input.length
              ? input[idx] * (1 - frac) + input[idx + 1] * frac
              : input[idx] || 0
          }
          return output
        }

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          const inputData = e.inputBuffer.getChannelData(0)

          // Resample from native rate to provider's expected rate
          const resampled = resample(inputData, nativeRate, sampleRate)

          const int16 = new Int16Array(resampled.length)
          for (let i = 0; i < resampled.length; i++) {
            const s = Math.max(-1, Math.min(1, resampled[i]))
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
          }
          const bytes = new Uint8Array(int16.buffer)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
          const b64 = btoa(binary)

          if (activeProvider === 'elevenlabs') {
            ws.send(JSON.stringify({ user_audio_chunk: b64 }))
          } else if (activeProvider === 'google') {
            ws.send(JSON.stringify({ type: 'audio', data: b64 }))
          } else {
            // OpenAI / Grok / Custom providers — all use generic audio format
            // Custom providers using openai_compatible or generic protocol both accept this
            ws.send(JSON.stringify({ type: 'audio', data: b64 }))
          }
        }

        source.connect(processor)
        processor.connect(audioCtx.destination)
      }

      ws.onmessage = (evt) => {
        try {
          if (typeof evt.data === 'string') {
            const msg = JSON.parse(evt.data)

            // Route to the right handler
            if (activeProvider === 'elevenlabs') {
              handleElevenLabsMessage(msg)
            } else if (activeProvider === 'google') {
              handleGeminiMessage(msg)
            } else if (activeProvider === 'openai' || activeProvider === 'grok') {
              handleOpenAIMessage(msg)
            } else {
              // Custom provider — use generic handler
              handleCustomMessage(msg)
            }
          } else if (evt.data instanceof Blob) {
            // Binary audio frames (some custom providers)
            evt.data.arrayBuffer().then(buf => {
              audioQueueRef.current.push(buf)
              setStatus('speaking')
              playNextAudio()
            })
          }
        } catch {}
      }

      ws.onerror = (e) => { console.error('WS error:', e); setError(`Erreur WebSocket ${activeProvider}`); setStatus('error') }
      ws.onclose = (e) => {
        console.log(`WS closed: code=${e.code} reason=${e.reason}`)
        if (e.code !== 1000 && e.code !== 1005) {
          setError(`Déconnecté (${e.code}): ${e.reason || 'connexion fermée'}`)
        }
        setStatus('idle')
        cleanupAudio()
        // Auto-save session if there were messages
        if (conversation.length > 0) saveCurrentSession()
      }

    } catch (err: any) {
      setError(err?.message || 'Impossible de démarrer')
      setStatus('error')
      cleanupAudio()
    }
  }, [activeProvider, providers, playNextAudio])

  // ── Message handlers per provider ────────────────────────────────────

  const handleElevenLabsMessage = (msg: any) => {
    // ElevenLabs ConvAI WebSocket protocol events

    // Audio: {type: "audio", audio_event: {audio_base_64: "..."}}
    if (msg.type === 'audio' && msg.audio_event?.audio_base_64) {
      setStatus('speaking')
      const raw = atob(msg.audio_event.audio_base_64)
      const buf = new ArrayBuffer(raw.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
      audioQueueRef.current.push(buf)
      playNextAudio()
    }
    // User transcript: {type: "user_transcript", user_transcription_event: {user_transcript: "..."}}
    if (msg.type === 'user_transcript' || msg.user_transcription_event) {
      const text = msg.user_transcription_event?.user_transcript || msg.user_transcript || ''
      if (text.trim()) setConversation(prev => [...prev, { role: 'user', text, ts: Date.now() }])
    }
    // Agent response: {type: "agent_response", agent_response_event: {agent_response: "..."}}
    if (msg.type === 'agent_response' || msg.agent_response_event) {
      const text = msg.agent_response_event?.agent_response || msg.agent_response || ''
      if (text.trim()) setConversation(prev => [...prev, { role: 'assistant', text, ts: Date.now() }])
    }
    // Connection established
    if (msg.type === 'conversation_initiation_metadata') {
      setStatus('listening')
    }
    // Interruption
    if (msg.type === 'interruption') { audioQueueRef.current = []; isPlayingRef.current = false; setStatus('listening') }
    // Ping — must reply with pong + event_id
    if (msg.type === 'ping') {
      wsRef.current?.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id || msg.event_id }))
    }
    // Error
    if (msg.type === 'error') { setError(msg.message || msg.error || 'Erreur ElevenLabs'); setStatus('error') }
  }

  const handleOpenAIMessage = (msg: any) => {
    // session.ready from our relay
    if (msg.type === 'session.ready') return

    // Audio delta
    if (msg.type === 'response.audio.delta' && msg.delta) {
      setStatus('speaking')
      const raw = atob(msg.delta)
      const buf = new ArrayBuffer(raw.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
      audioQueueRef.current.push(buf)
      playNextAudio()
    }
    // Transcripts
    if (msg.type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
      setConversation(prev => [...prev, { role: 'user', text: msg.transcript, ts: Date.now() }])
    }
    if (msg.type === 'response.audio_transcript.done' && msg.transcript) {
      setConversation(prev => [...prev, { role: 'assistant', text: msg.transcript, ts: Date.now() }])
    }
    // Speech detection
    if (msg.type === 'input_audio_buffer.speech_started') setStatus('listening')
    if (msg.type === 'response.done') {
      setStatus('listening')
      audioQueueRef.current = []
      isPlayingRef.current = false
    }
    // Error
    if (msg.type === 'error') setError(msg.error?.message || 'Erreur OpenAI')
  }

  const handleGeminiMessage = (msg: any) => {
    if (msg.type === 'session.ready') return
    if (msg.type === 'audio' && msg.data) {
      setStatus('speaking')
      const raw = atob(msg.data)
      const buf = new ArrayBuffer(raw.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
      audioQueueRef.current.push(buf)
      playNextAudio()
    }
    if (msg.type === 'transcript') {
      if (msg.text?.trim()) {
        setConversation(prev => [...prev, { role: msg.role || 'assistant', text: msg.text, ts: Date.now() }])
      }
    }
    if (msg.type === 'turn_complete') { setStatus('listening') }
    if (msg.type === 'interruption') { audioQueueRef.current = []; isPlayingRef.current = false; setStatus('listening') }
    if (msg.type === 'error') setError(msg.error || 'Erreur Gemini')
  }

  // Generic handler for custom providers — works with relay's normalized output
  const handleCustomMessage = (msg: any) => {
    if (msg.type === 'session.ready') return
    // Audio (relay normalizes to {type: "audio", data: base64})
    if (msg.type === 'audio' && msg.data) {
      setStatus('speaking')
      const raw = atob(msg.data)
      const buf = new ArrayBuffer(raw.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
      audioQueueRef.current.push(buf)
      playNextAudio()
    }
    // Transcript (relay normalizes to {type: "transcript", role, text})
    if (msg.type === 'transcript' && msg.text?.trim()) {
      setConversation(prev => [...prev, { role: msg.role || 'assistant', text: msg.text, ts: Date.now() }])
    }
    // OpenAI-compatible events (if protocol_type = openai_compatible, relay forwards raw)
    if (msg.type === 'response.audio.delta' && msg.delta) {
      setStatus('speaking')
      const raw = atob(msg.delta)
      const buf = new ArrayBuffer(raw.length)
      const view = new Uint8Array(buf)
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
      audioQueueRef.current.push(buf)
      playNextAudio()
    }
    if (msg.type === 'response.audio_transcript.delta' && msg.delta) {
      setConversation(prev => {
        const last = prev[prev.length - 1]
        if (last?.role === 'assistant' && Date.now() - last.ts < 10000) {
          return [...prev.slice(0, -1), { ...last, text: last.text + msg.delta }]
        }
        return [...prev, { role: 'assistant', text: msg.delta, ts: Date.now() }]
      })
    }
    if (msg.type === 'turn_complete' || msg.type === 'response.done') setStatus('listening')
    if (msg.type === 'interruption' || msg.type === 'input_audio_buffer.speech_started') {
      audioQueueRef.current = []; isPlayingRef.current = false; setStatus('listening')
    }
    if (msg.type === 'error') setError(msg.error || msg.message || 'Erreur provider')
  }

  // ── Session management ───────────────────────────────────────────────

  const cleanupAudio = () => {
    processorRef.current?.disconnect()
    sourceNodeRef.current?.disconnect()
    streamRef.current?.getTracks().forEach(t => t.stop())
    processorRef.current = null; sourceNodeRef.current = null; streamRef.current = null
    audioQueueRef.current = []; isPlayingRef.current = false
  }

  const endSession = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    cleanupAudio()
    setStatus('idle')
  }, [])

  const saveCurrentSession = useCallback(() => {
    if (conversation.length === 0) return
    const duration = Math.round((Date.now() - sessionStart) / 1000)
    const title = conversation[0]?.text?.substring(0, 50) || 'Session vocale'
    fetch(`${API}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: activeProvider, messages: conversation, duration_seconds: duration, title }),
    })
      .then(r => r.json())
      .then(data => { if (data.session) setSessions(prev => [data.session, ...prev]) })
      .catch(() => {})
  }, [conversation, activeProvider, sessionStart])

  const toggleSession = useCallback(() => {
    if (wsRef.current) {
      if (conversation.length > 0) saveCurrentSession()
      endSession()
    } else {
      startSession()
    }
  }, [startSession, endSession, saveCurrentSession, conversation])

  const testProvider = async (name: string) => {
    setTestingProvider(name)
    try {
      const resp = await fetch(`${API}/provider/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: name }),
      })
      const data = await resp.json()
      if (data.ok) setError(null)
      else setError(data.error || 'Test échoué')
    } catch { setError('Erreur réseau') }
    finally { setTestingProvider(null) }
  }

  const deleteSession = async (id: string) => {
    await fetch(`${API}/sessions/${id}`, { method: 'DELETE' })
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  // ── Keyboard shortcut (Space) ────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); toggleSession() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSession])

  // ── Derived state ────────────────────────────────────────────────────
  const isConnected = status === 'listening' || status === 'speaking'
  const currentProvider = providers.find(p => p.name === activeProvider)
  const enabledProviders = providers.filter(p => p.enabled)

  // ── Styles ───────────────────────────────────────────────────────────
  const S = {
    btn: (active = false) => ({
      padding: '6px 12px', borderRadius: 8, border: 'none', fontSize: 11, fontWeight: 600,
      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
      background: active ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-tertiary)',
      color: active ? 'var(--accent-primary-light)' : 'var(--text-secondary)',
      transition: 'all 0.15s',
    } as const),
    card: {
      background: 'var(--bg-secondary)', borderRadius: 12,
      border: '1px solid var(--border-subtle)', padding: 16,
    } as const,
  }

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex-1 flex h-screen overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
      {/* ── Main area ─────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl" style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }}>
              <Radio className="w-5 h-5" style={{ color: 'var(--accent-primary-light)' }} />
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <h1 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Chat Vocal Temps Réel</h1>
                <span
                  className="text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    background: 'color-mix(in srgb, var(--scarlet) 10%, transparent)',
                    color: 'color-mix(in srgb, var(--scarlet) 80%, var(--text-muted))',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)',
                  }}
                >v1.0.1</span>
              </div>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {enabledProviders.length} provider{enabledProviders.length !== 1 ? 's' : ''} disponible{enabledProviders.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Provider selector */}
            <div className="relative">
              <button onClick={() => setProviderDropdown(!providerDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                <span>{currentProvider?.icon || '🔊'}</span>
                <span>{currentProvider?.display_name || activeProvider}</span>
                <ChevronDown className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
              </button>
              {providerDropdown && (
                <div className="absolute right-0 top-full mt-1 py-1 rounded-lg shadow-xl z-50 min-w-[200px]"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
                  {providers.map(p => (
                    <button key={p.name} onClick={() => { setActiveProvider(p.name); setProviderDropdown(false) }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors"
                      style={{
                        color: p.enabled ? 'var(--text-primary)' : 'var(--text-muted)',
                        background: p.name === activeProvider ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'transparent',
                        opacity: p.enabled ? 1 : 0.5,
                      }}>
                      <span style={{ fontSize: 14 }}>{p.icon}</span>
                      <div className="flex-1">
                        <div className="font-medium">{p.display_name}</div>
                        <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{p.description}</div>
                      </div>
                      {p.enabled && <div className="w-1.5 h-1.5 rounded-full" style={{ background: PROVIDER_COLORS[p.name] || 'var(--accent-success)' }} />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Connection indicator */}
            <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium"
              style={{
                background: isConnected ? 'color-mix(in srgb, var(--accent-success) 10%, transparent)' : 'var(--bg-tertiary)',
                color: STATUS_COLOR[status],
              }}>
              {isConnected ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
              <span>{isConnected ? 'Connecté' : status === 'connecting' ? '…' : 'Off'}</span>
            </div>

            {/* Mute */}
            <button onClick={() => setIsMuted(!isMuted)} className="p-1.5 rounded-lg transition-colors"
              style={{ color: isMuted ? 'var(--accent-danger)' : 'var(--text-muted)' }}
              title={isMuted ? 'Réactiver le son' : 'Couper le son'}>
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            {/* Side panels */}
            <button onClick={() => setSideView(sideView === 'providers' ? 'none' : 'providers')} style={S.btn(sideView === 'providers')}>
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setSideView(sideView === 'history' ? 'none' : 'history')} style={S.btn(sideView === 'history')}>
              <History className="w-3.5 h-3.5" />
              {sessions.length > 0 && <span className="text-[9px]">{sessions.length}</span>}
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mt-3 p-3 rounded-lg flex items-start gap-2"
            style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-danger) 25%, transparent)' }}>
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-danger)' }} />
            <p className="text-xs flex-1" style={{ color: 'var(--accent-danger)' }}>{error}</p>
            <button onClick={() => setError(null)} className="p-0.5"><X className="w-3 h-3" style={{ color: 'var(--text-muted)' }} /></button>
          </div>
        )}

        {/* Agent creation banner (ElevenLabs only) */}
        {needsAgent && activeProvider === 'elevenlabs' && (
          <div className="mx-4 mt-3 p-3 rounded-lg border flex items-center gap-3"
            style={{ background: 'color-mix(in srgb, var(--accent-primary) 5%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
            <div className="flex-1">
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Agent vocal non configuré</p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                Un agent ElevenLabs ConvAI est nécessaire pour le chat vocal.
              </p>
            </div>
            <button onClick={createAgent} disabled={creatingAgent}
              className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5"
              style={{
                background: creatingAgent ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))',
                color: 'var(--text-primary)', opacity: creatingAgent ? 0.6 : 1,
              }}>
              {creatingAgent ? <><Loader2 className="w-3 h-3 animate-spin" /> Création…</> : <><Plus className="w-3 h-3" /> Créer l'agent</>}
            </button>
          </div>
        )}

        {/* ── Main content: mic button + conversation ──────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Mic area */}
          <div className="flex flex-col items-center justify-center py-12 relative flex-shrink-0">
            {/* Ambient glow */}
            {isConnected && (
              <div className="absolute inset-0 pointer-events-none"
                style={{ background: `radial-gradient(ellipse 400px 250px at 50% 50%, color-mix(in srgb, ${PROVIDER_COLORS[activeProvider] || 'var(--accent-primary)'} 8%, transparent) 0%, transparent 70%)` }} />
            )}

            {/* Pulse rings */}
            <div className="relative flex items-center justify-center mb-6">
              {(isConnected ? [0, 1, 2] : status === 'connecting' ? [0] : []).map(i => (
                <div key={i} className="absolute rounded-full"
                  style={{
                    width: 110 + i * 44, height: 110 + i * 44,
                    border: `1.5px solid color-mix(in srgb, ${PROVIDER_COLORS[activeProvider] || 'var(--accent-primary)'} ${status === 'speaking' ? 50 : 25}%, transparent)`,
                    animation: isConnected ? `vpulse ${1.4 + i * 0.35}s ease-in-out infinite` : 'none',
                    animationDelay: `${i * 0.15}s`,
                  }} />
              ))}

              {/* Main button */}
              <button onClick={toggleSession}
                disabled={status === 'connecting' || (activeProvider === 'elevenlabs' && needsAgent)}
                className="relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 select-none"
                style={{
                  background: isConnected
                    ? `linear-gradient(135deg, ${PROVIDER_COLORS[activeProvider] || 'var(--accent-primary)'}, color-mix(in srgb, ${PROVIDER_COLORS[activeProvider] || 'var(--accent-primary)'} 60%, black))`
                    : 'linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary))',
                  border: `2px solid ${isConnected ? PROVIDER_COLORS[activeProvider] || 'var(--accent-primary)' : 'var(--border)'}`,
                  boxShadow: isConnected ? `0 0 40px color-mix(in srgb, ${PROVIDER_COLORS[activeProvider] || 'var(--accent-primary)'} 40%, transparent)` : 'none',
                  opacity: status === 'connecting' ? 0.4 : 1,
                  cursor: status === 'connecting' ? 'wait' : 'pointer',
                }}>
                {status === 'connecting'
                  ? <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--text-primary)' }} />
                  : isConnected
                    ? status === 'speaking'
                      ? <Volume2 className="w-8 h-8" style={{ color: 'var(--text-primary)', opacity: 0.9 }} />
                      : <Mic className="w-8 h-8 animate-pulse" style={{ color: 'var(--text-primary)' }} />
                    : <Mic className="w-8 h-8" style={{ color: 'var(--text-primary)' }} />
                }
              </button>
            </div>

            {/* Status text */}
            <p className="text-xs font-medium text-center px-6" style={{ color: STATUS_COLOR[status] }}>
              {STATUS_LABEL[status]}
            </p>
            <p className="text-[10px] mt-1.5" style={{ color: 'var(--border)' }}>
              {!isConnected && status !== 'connecting' && 'Clic ou Espace pour démarrer'}
              {isConnected && `${currentProvider?.display_name || activeProvider} · Espace pour arrêter`}
            </p>
            {isConnected && (
              <button onClick={() => { saveCurrentSession(); endSession() }}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all"
                style={{ background: 'color-mix(in srgb, var(--accent-danger) 15%, transparent)', color: 'var(--accent-danger)' }}>
                <PhoneOff className="w-3 h-3" /> Raccrocher
              </button>
            )}
          </div>

          {/* ── Conversation transcript ────────────────────────────────── */}
          {conversation.length > 0 && (
            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-2">
              {conversation.map((entry, i) => (
                <div key={`${entry.ts}-${i}`} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[75%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed"
                    style={{
                      background: entry.role === 'user'
                        ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)'
                        : 'var(--bg-secondary)',
                      border: `1px solid ${entry.role === 'user' ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : 'var(--border-subtle)'}`,
                      color: 'var(--text-primary)',
                    }}>
                    {entry.text}
                  </div>
                </div>
              ))}
              <div ref={convEndRef} />
            </div>
          )}

          {conversation.length === 0 && status === 'idle' && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center px-8">
                <Sparkles className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--border)', opacity: 0.5 }} />
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Démarrez une conversation vocale avec votre assistant IA.
                  <br />Les transcriptions apparaîtront ici en temps réel.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t flex items-center justify-center flex-shrink-0"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="text-[10px]" style={{ color: 'var(--border)' }}>
            {currentProvider?.display_name || activeProvider} · Chat Vocal Temps Réel
          </span>
        </div>
      </div>

      {/* ── Side panel ───────────────────────────────────────────────── */}
      {sideView !== 'none' && (
        <div className="w-[320px] border-l flex flex-col flex-shrink-0 overflow-hidden"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>

          <div className="flex items-center justify-between px-4 py-3 border-b"
            style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
              {sideView === 'providers' ? 'Providers Vocaux' : 'Historique'}
            </span>
            <button onClick={() => setSideView('none')} className="p-1 rounded" style={{ color: 'var(--text-muted)' }}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {sideView === 'providers' && providers.map(p => (
              <div key={p.name} className="rounded-xl p-3 border transition-all"
                style={{
                  background: p.name === activeProvider ? 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' : 'var(--bg-primary)',
                  borderColor: p.name === activeProvider ? 'color-mix(in srgb, var(--accent-primary) 25%, transparent)' : 'var(--border-subtle)',
                }}>
                <div className="flex items-center gap-2.5 mb-2">
                  <span style={{ fontSize: 18 }}>{p.icon}</span>
                  <div className="flex-1">
                    <div className="text-xs font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      {p.display_name}
                      {p.enabled && <div className="w-1.5 h-1.5 rounded-full" style={{ background: PROVIDER_COLORS[p.name] || 'var(--accent-success)' }} />}
                    </div>
                    <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{p.description}</div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  <span style={{ color: p.has_voice_key || p.has_llm_key ? 'var(--accent-success)' : 'var(--text-muted)' }}>
                    {p.has_voice_key || p.has_llm_key ? '✓ Clé API' : '✗ Pas de clé'}
                  </span>
                  {p.name === 'elevenlabs' && (
                    <span style={{ color: p.has_agent ? 'var(--accent-success)' : 'var(--text-muted)' }}>
                      · {p.has_agent ? '✓ Agent' : '✗ Agent'}
                    </span>
                  )}
                  <span className="ml-auto text-[8px] uppercase tracking-wider"
                    style={{ color: 'var(--text-muted)' }}>
                    {p.mode === 'direct' ? 'direct' : 'relay'}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-2.5">
                  {p.enabled && p.name !== activeProvider && (
                    <button onClick={() => setActiveProvider(p.name)}
                      className="flex-1 py-1.5 rounded-lg text-[10px] font-medium text-center"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                      Utiliser
                    </button>
                  )}
                  {p.name === activeProvider && (
                    <span className="flex-1 py-1.5 rounded-lg text-[10px] font-medium text-center flex items-center justify-center gap-1"
                      style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' }}>
                      <Check className="w-3 h-3" /> Actif
                    </span>
                  )}
                  <button onClick={() => testProvider(p.name)} disabled={!p.enabled || testingProvider === p.name}
                    className="px-2 py-1.5 rounded-lg text-[10px]"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)', opacity: p.enabled ? 1 : 0.4 }}>
                    {testingProvider === p.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            ))}

            {sideView === 'history' && sessions.length === 0 && (
              <div className="text-center py-8">
                <MessageSquare className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--border)', opacity: 0.5 }} />
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Aucune session enregistrée</p>
              </div>
            )}

            {sideView === 'history' && sessions.map(s => (
              <div key={s.id} className="rounded-xl p-3 border cursor-pointer transition-all group"
                onClick={() => { setConversation(s.messages || []); setSideView('none') }}
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {s.title || 'Session vocale'}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                      <span>{PROVIDER_INFO_MINI[s.provider] || s.provider}</span>
                      <span>·</span>
                      <span>{s.messages?.length || 0} msg</span>
                      {s.duration_seconds > 0 && <>
                        <span>·</span>
                        <Clock className="w-2.5 h-2.5" />
                        <span>{Math.floor(s.duration_seconds / 60)}:{(s.duration_seconds % 60).toString().padStart(2, '0')}</span>
                      </>}
                    </div>
                    <div className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {new Date(s.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: 'var(--text-muted)' }}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Animations */}
      <style>{`@keyframes vpulse { 0%, 100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.1); opacity: 0.25; } }`}</style>
    </div>
  )
}

// Mini provider names for history display
const PROVIDER_INFO_MINI: Record<string, string> = {
  elevenlabs: '🎙️ ElevenLabs',
  openai: '💚 OpenAI',
  google: '🔷 Gemini',
  grok: '⚡ Grok',
}
