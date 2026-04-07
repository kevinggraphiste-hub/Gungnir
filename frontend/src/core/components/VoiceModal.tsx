/**
 * VoiceModal — Chat vocal temps réel via ElevenLabs Conversational AI
 *
 * Utilise le WebSocket natif ElevenLabs ConvAI.
 * Le backend génère le signed URL via /api/voice/convai/signed-url.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Mic, Volume2, VolumeX, X, Radio,
  AlertCircle, Loader2, Plus, Wifi, WifiOff
} from 'lucide-react'
import { useStore } from '../stores/appStore'

type ConvEntry = { role: 'user' | 'assistant'; text: string; ts: number }
type Status = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error'

const STATUS_LABEL: Record<Status, string> = {
  idle:       'Session prête — cliquez pour démarrer',
  connecting: 'Connexion à ElevenLabs…',
  listening:  'En écoute — parlez naturellement',
  speaking:   'L\'assistant parle…',
  error:      'Erreur de connexion',
}

const STATUS_COLOR: Record<Status, string> = {
  idle:       'var(--text-muted)',
  connecting: 'var(--accent-tertiary)',
  listening:  'var(--accent-success)',
  speaking:   'var(--accent-primary)',
  error:      'var(--accent-danger)',
}

interface VoiceModalProps { isOpen: boolean; onClose: () => void }

export default function VoiceModal({ isOpen, onClose }: VoiceModalProps) {
  const agentName = useStore((s) => s.agentName)
  const [status, setStatus] = useState<Status>('idle')
  const [conversation, setConversation] = useState<ConvEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [needsAgent, setNeedsAgent] = useState(false)
  const [creatingAgent, setCreatingAgent] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const convEndRef = useRef<HTMLDivElement | null>(null)
  const audioQueueRef = useRef<ArrayBuffer[]>([])
  const isPlayingRef = useRef(false)

  useEffect(() => { convEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [conversation])

  useEffect(() => {
    if (!isOpen) return
    fetch('/api/voice/convai/config')
      .then(r => { if (!r.headers.get('content-type')?.includes('application/json')) throw new Error('Not JSON'); return r.json() })
      .then(data => { if (!data.configured && data.has_api_key) setNeedsAgent(true) })
      .catch(() => {})
  }, [isOpen])

  useEffect(() => { return () => endSession() }, [])

  const playNextAudio = useCallback(() => {
    if (isMuted || audioQueueRef.current.length === 0 || isPlayingRef.current) return
    isPlayingRef.current = true
    const pcmData = audioQueueRef.current.shift()!
    const ctx = audioCtxRef.current || new AudioContext({ sampleRate: 16000 })
    audioCtxRef.current = ctx
    const int16 = new Int16Array(pcmData)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0
    const buffer = ctx.createBuffer(1, float32.length, 16000)
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
  }, [isMuted])

  const createAgent = useCallback(async () => {
    setCreatingAgent(true); setError(null)
    try {
      const resp = await fetch('/api/voice/convai/create-agent', { method: 'POST' })
      if (!resp.headers.get('content-type')?.includes('application/json')) throw new Error('Backend non joignable')
      const data = await resp.json()
      if (data.agent_id) setNeedsAgent(false)
      else setError(data.error || 'Impossible de créer l\'agent')
    } catch (err: any) { setError(err?.message || 'Erreur réseau') }
    finally { setCreatingAgent(false) }
  }, [])

  const startSession = useCallback(async () => {
    setError(null); setStatus('connecting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      streamRef.current = stream
      const resp = await fetch('/api/voice/convai/signed-url')
      if (!resp.headers.get('content-type')?.includes('application/json')) {
        setError('Backend non joignable'); setStatus('error'); stream.getTracks().forEach(t => t.stop()); return
      }
      const data = await resp.json()
      if (!resp.ok || data.error) {
        if (data.error?.includes('Agent ID')) setNeedsAgent(true)
        setError(data.error || 'Erreur signed URL'); setStatus('error'); stream.getTracks().forEach(t => t.stop()); return
      }
      const ws = new WebSocket(data.signed_url)
      wsRef.current = ws
      ws.onopen = () => {
        setStatus('listening'); setError(null)
        const audioCtx = new AudioContext({ sampleRate: 16000 }); audioCtxRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream); sourceNodeRef.current = source
        const processor = audioCtx.createScriptProcessor(4096, 1, 1); processorRef.current = processor
        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return
          const inputData = e.inputBuffer.getChannelData(0)
          const int16 = new Int16Array(inputData.length)
          for (let i = 0; i < inputData.length; i++) { const s = Math.max(-1, Math.min(1, inputData[i])); int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF }
          const bytes = new Uint8Array(int16.buffer); let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
          ws.send(JSON.stringify({ user_audio_chunk: btoa(binary) }))
        }
        source.connect(processor); processor.connect(audioCtx.destination)
      }
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data)
          if (msg.audio) {
            setStatus('speaking')
            const raw = atob(msg.audio); const buf = new ArrayBuffer(raw.length); const view = new Uint8Array(buf)
            for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i)
            audioQueueRef.current.push(buf); playNextAudio()
          }
          if (msg.type === 'user_transcript' || msg.user_transcription_event?.user_transcript) {
            const text = msg.user_transcript || msg.user_transcription_event?.user_transcript || ''
            if (text.trim()) setConversation(prev => [...prev, { role: 'user', text, ts: Date.now() }])
          }
          if (msg.type === 'agent_response' || msg.agent_response_event) {
            const text = msg.agent_response || msg.agent_response_event?.agent_response || ''
            if (text.trim()) setConversation(prev => [...prev, { role: 'assistant', text, ts: Date.now() }])
          }
          if (msg.type === 'interruption') { audioQueueRef.current = []; isPlayingRef.current = false; setStatus('listening') }
          if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
        } catch {}
      }
      ws.onerror = () => { setError('Erreur WebSocket ElevenLabs'); setStatus('error') }
      ws.onclose = () => { setStatus('idle'); cleanupAudio() }
    } catch (err: any) { console.error('ConvAI session error:', err); setError(err?.message || 'Impossible de démarrer la session'); setStatus('error') }
  }, [playNextAudio])

  const cleanupAudio = () => {
    processorRef.current?.disconnect(); sourceNodeRef.current?.disconnect()
    streamRef.current?.getTracks().forEach(t => t.stop())
    processorRef.current = null; sourceNodeRef.current = null; streamRef.current = null
    audioQueueRef.current = []; isPlayingRef.current = false
  }

  const endSession = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    cleanupAudio(); setStatus('idle')
  }, [])

  const toggleSession = useCallback(() => {
    if (wsRef.current) endSession(); else startSession()
  }, [startSession, endSession])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); toggleSession() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, toggleSession])

  const handleClose = () => { endSession(); onClose() }
  const isConnected = status === 'listening' || status === 'speaking'

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>
      <div className="relative w-full sm:w-[500px] sm:max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>

        <div className="flex items-center justify-between px-5 py-3.5 border-b flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' }}>
              <Radio className="w-4 h-4" style={{ color: 'var(--accent-primary-light)' }} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>Chat Vocal Temps Réel</p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>ElevenLabs Conversational AI</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setIsMuted(!isMuted)} className="p-1.5 rounded-lg transition-colors"
              style={{ color: isMuted ? 'var(--accent-primary-light)' : 'var(--text-muted)' }}>
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium mx-1"
              style={{ background: isConnected ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--text-muted) 12%, transparent)', color: STATUS_COLOR[status] }}>
              {isConnected ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
              <span className="ml-0.5">{isConnected ? 'Connecté' : status === 'connecting' ? '…' : 'Off'}</span>
            </div>
            <button onClick={handleClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 p-3 rounded-lg flex items-start gap-2"
            style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-danger) 30%, transparent)' }}>
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-primary-light)' }} />
            <p className="text-xs" style={{ color: 'var(--accent-primary-light)' }}>{error}</p>
          </div>
        )}

        {needsAgent && (
          <div className="mx-4 mt-3 p-3 rounded-lg border flex items-center gap-3"
            style={{ background: 'color-mix(in srgb, var(--accent-primary) 5%, transparent)', borderColor: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
            <div className="flex-1">
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Agent vocal non configuré</p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>Cliquez pour créer l'agent automatiquement.</p>
            </div>
            <button onClick={createAgent} disabled={creatingAgent}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5"
              style={{ background: creatingAgent ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: creatingAgent ? 'var(--text-muted)' : 'var(--text-primary)', opacity: creatingAgent ? 0.6 : 1 }}>
              {creatingAgent ? <><Loader2 className="w-3 h-3 animate-spin" /> Création…</> : <><Plus className="w-3 h-3" /> Créer</>}
            </button>
          </div>
        )}

        <div className="flex flex-col items-center justify-center py-8 relative flex-shrink-0">
          {isConnected && (
            <div className="absolute inset-0 pointer-events-none"
              style={{ background: 'radial-gradient(ellipse 320px 200px at 50% 50%, color-mix(in srgb, var(--accent-primary) 7%, transparent) 0%, transparent 70%)' }} />
          )}
          <div className="relative flex items-center justify-center mb-5">
            {(isConnected ? [0,1,2] : status === 'connecting' ? [0] : []).map(i => (
              <div key={i} className="absolute rounded-full transition-all duration-150"
                style={{
                  width: 100 + i * 40, height: 100 + i * 40,
                  border: `1px solid color-mix(in srgb, var(--accent-primary) ${status === 'listening' ? 30 : status === 'speaking' ? 50 : 15}%, transparent)`,
                  animation: isConnected ? `vm-pulse ${1.4 + i * 0.35}s ease-in-out infinite` : 'none',
                  animationDelay: `${i * 0.15}s`,
                }} />
            ))}
            <button onClick={toggleSession} disabled={status === 'connecting'}
              className="relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 select-none"
              style={{
                background: isConnected
                  ? status === 'speaking' ? 'linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 50%, black), color-mix(in srgb, var(--scarlet-dark) 50%, black))' : 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))'
                  : 'linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary))',
                border: `2px solid ${isConnected ? 'var(--accent-danger)' : 'var(--border)'}`,
                boxShadow: isConnected ? '0 0 30px color-mix(in srgb, var(--accent-primary) 40%, transparent)' : 'none',
                opacity: status === 'connecting' ? 0.4 : 1,
              }}>
              {isConnected
                ? status === 'listening' ? <Mic className="w-7 h-7 animate-pulse" style={{ color: 'var(--text-primary)' }} /> : <Volume2 className="w-7 h-7" style={{ color: 'var(--text-primary)', opacity: 0.8 }} />
                : <Mic className="w-7 h-7" style={{ color: status !== 'error' ? 'var(--text-primary)' : 'var(--text-muted)' }} />}
            </button>
          </div>
          <p className="text-xs font-medium text-center px-6" style={{ color: STATUS_COLOR[status] }}>{STATUS_LABEL[status]}</p>
          <p className="text-[10px] mt-1" style={{ color: 'var(--border)' }}>
            {!isConnected && status !== 'connecting' && 'Clic ou espace pour démarrer'}
            {status === 'listening' && `Parlez naturellement — ${agentName} écoute`}
            {status === 'speaking' && `${agentName} répond…`}
          </p>
        </div>

        {conversation.length > 0 && (
          <div className="overflow-y-auto flex-1 px-4 pb-3 space-y-2" style={{ maxHeight: '240px' }}>
            {conversation.map((entry, i) => (
              <div key={`${entry.ts}-${i}`} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-[82%] px-3 py-2 rounded-xl text-xs leading-relaxed"
                  style={{
                    background: entry.role === 'user' ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                    border: `1px solid ${entry.role === 'user' ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : 'color-mix(in srgb, var(--text-primary) 6%, transparent)'}`,
                    color: entry.role === 'user' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}>{entry.text}</div>
              </div>
            ))}
            <div ref={convEndRef} />
          </div>
        )}

        <div className="px-5 py-2.5 border-t flex-shrink-0 flex items-center justify-center" style={{ borderColor: 'var(--bg-secondary)' }}>
          <span className="text-[10px]" style={{ color: 'var(--border)' }}>ElevenLabs Conversational AI · Espace pour démarrer/arrêter</span>
        </div>
      </div>

      <style>{`@keyframes vm-pulse { 0%, 100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.08); opacity: 0.3; } }`}</style>
    </div>
  )
}
