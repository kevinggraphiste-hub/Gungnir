/**
 * VoiceModal — Conversation vocale avec Gungnir (mode temps quasi-réel).
 *
 * Remplace l'ancienne intégration ElevenLabs Convai par un flow qui utilise
 * le cerveau Gungnir complet (modèles LLM config, skills, conscience,
 * sous-agents, orchestration, tool-calling) :
 *
 *   1. STT local : MediaRecorder → Whisper WASM (transformers.js)
 *                  Aucune donnée ne quitte le navigateur pour le STT.
 *   2. LLM       : POST /api/conversations/{id}/chat (streaming SSE)
 *                  TON pipeline chat normal — tous les tools agent dispo.
 *   3. TTS       : détection fin de phrase dans le stream → POST /api/chat/tts
 *                  (ElevenLabs) → queue audio lecture séquentielle.
 *   4. Auto-loop : fin de la lecture TTS → relance automatique du mic pour
 *                  la question suivante. Stop explicite au bouton central.
 *
 * Le plugin `voice` indépendant garde ses propres endpoints /convai/* — seule
 * la modal du chat principal est impactée ici.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Mic, Volume2, VolumeX, X, Radio,
  AlertCircle, Loader2, Square, Brain, Sparkles,
} from 'lucide-react'
import { useStore } from '../stores/appStore'
import { api, apiFetch } from '../services/api'
import { loadTranscriber, transcribeBlob } from '../services/whisper'

type ConvEntry = { role: 'user' | 'assistant'; text: string; ts: number }
type Status = 'idle' | 'loading-model' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error'

const STATUS_LABEL: Record<Status, string> = {
  idle:          'Prêt — clic sur le micro pour démarrer',
  'loading-model': 'Chargement du modèle Whisper…',
  recording:     'En écoute — parlez, puis clic stop',
  transcribing:  'Transcription en cours…',
  thinking:      'Gungnir réfléchit…',
  speaking:      'Gungnir répond…',
  error:         'Erreur',
}

const STATUS_COLOR: Record<Status, string> = {
  idle:          'var(--text-muted)',
  'loading-model': 'var(--accent-tertiary)',
  recording:     'var(--scarlet)',
  transcribing:  'var(--accent-tertiary)',
  thinking:      'var(--accent-primary)',
  speaking:      'var(--accent-primary)',
  error:         'var(--accent-danger)',
}

interface VoiceModalProps { isOpen: boolean; onClose: () => void }

export default function VoiceModal({ isOpen, onClose }: VoiceModalProps) {
  const agentName = useStore((s) => s.agentName)
  const currentConversation = useStore((s) => s.currentConversation)
  const selectedProvider = useStore((s) => s.selectedProvider)
  const selectedModel = useStore((s) => s.selectedModel)
  const setCurrentConversation = useStore((s) => s.setCurrentConversation)

  const [status, setStatus] = useState<Status>('idle')
  const [conversation, setConversation] = useState<ConvEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [modelProgress, setModelProgress] = useState(0)
  const [recordingSec, setRecordingSec] = useState(0)

  // Voix ElevenLabs préférée du user (stockée dans Settings → Voix). On la
  // lit au mount via /api/plugins/voice/convai/config et on l'envoie dans
  // chaque appel /chat/tts pour que l'agent vocal utilise CETTE voix au lieu
  // du fallback Rachel hardcodé. Per-user strict : c'est le token bearer
  // côté API qui résout l'utilisateur, pas une clé partagée.
  const [userVoiceId, setUserVoiceId] = useState<string | null>(null)

  // Refs session
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const convEndRef = useRef<HTMLDivElement | null>(null)

  // TTS playback queue
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsQueueRef = useRef<string[]>([])
  const ttsPlayingRef = useRef(false)

  // Session management (true = l'user a ouvert la conversation ; si tel est le
  // cas on relance le mic automatiquement à chaque fin de réponse)
  const sessionActiveRef = useRef(false)
  const convoIdRef = useRef<number | null>(null)

  // Scroll auto du transcript
  useEffect(() => { convEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [conversation])

  // Cleanup au démount
  useEffect(() => { return () => endSession() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  // Pré-chargement du modèle dès l'ouverture de la modal (confort UX : le 1er
  // clic n'attend plus 30s s'il arrive pile au moment du download).
  useEffect(() => {
    if (!isOpen) return
    // Fire-and-forget : le modèle sera en cache pour quand l'user cliquera
    loadTranscriber(pct => setModelProgress(pct)).catch(() => { /* silent */ })
  }, [isOpen])

  // Récupère le voice_id préféré de l'user (depuis ses settings ElevenLabs).
  // L'endpoint est per-user strict (auth bearer). Si l'user n'a pas configuré
  // de voix, on laisse `userVoiceId` à null → le backend tombe sur Rachel.
  useEffect(() => {
    if (!isOpen) return
    apiFetch('/api/plugins/voice/convai/config')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const vid = data?.voice_id
        if (vid && typeof vid === 'string') setUserVoiceId(vid)
      })
      .catch(() => { /* silent — on garde le fallback Rachel */ })
  }, [isOpen])

  // ─── Lecture TTS (queue séquentielle) ──────────────────────────────────
  const playNextTTS = useCallback(async () => {
    if (isMuted) return
    if (ttsPlayingRef.current) return
    if (ttsQueueRef.current.length === 0) return
    ttsPlayingRef.current = true
    const text = ttsQueueRef.current.shift()!
    try {
      const resp = await apiFetch('/api/chat/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // On force le voice_id préféré de l'user si on l'a chargé. Le backend
        // accepte `voice` dans le body et l'utilise tel quel — ça override
        // son fallback Rachel sans toucher à la logique pour les autres
        // call sites (Chat.tsx TTS toggle, etc.).
        body: JSON.stringify({
          text,
          provider: 'elevenlabs',
          ...(userVoiceId ? { voice: userVoiceId } : {}),
        }),
      })
      if (!resp.ok) {
        // TTS échoue (pas de clé ElevenLabs ?) → on saute la phrase sans bloquer
        const body = await resp.text().catch(() => '')
        console.warn('[VoiceModal] TTS failed:', resp.status, body.slice(0, 120))
        ttsPlayingRef.current = false
        if (ttsQueueRef.current.length > 0) playNextTTS()
        return
      }
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      ttsAudioRef.current = audio
      audio.onended = () => {
        URL.revokeObjectURL(url)
        ttsPlayingRef.current = false
        if (ttsQueueRef.current.length > 0) playNextTTS()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        ttsPlayingRef.current = false
        if (ttsQueueRef.current.length > 0) playNextTTS()
      }
      await audio.play()
    } catch (e: any) {
      console.warn('[VoiceModal] TTS exception:', e?.message)
      ttsPlayingRef.current = false
      if (ttsQueueRef.current.length > 0) playNextTTS()
    }
  }, [isMuted, userVoiceId])

  // ─── Envoi au chat Gungnir + streaming tokens → TTS par phrase ─────────
  const sendToGungnir = useCallback(async (userText: string, convoId: number) => {
    setStatus('thinking')
    ttsQueueRef.current = []
    let assistantFullText = ''
    let pendingBuffer = ''
    let firstTokenSeen = false
    try {
      const response = await api.chat(
        convoId,
        { message: userText, provider: selectedProvider, model: selectedModel },
        {
          onToken: (chunk: string) => {
            if (!firstTokenSeen) { firstTokenSeen = true; setStatus('speaking') }
            assistantFullText += chunk
            pendingBuffer += chunk
            // Découpe dès qu'une phrase complète apparaît (. ! ? suivi d'espace
            // ou fin). Permet de lancer le TTS en parallèle du streaming.
            while (true) {
              const m = pendingBuffer.match(/^([\s\S]*?[.!?])(\s+|$)/)
              if (!m) break
              const sentence = m[1].trim()
              pendingBuffer = pendingBuffer.slice(m[0].length)
              if (sentence.length > 2) {
                ttsQueueRef.current.push(sentence)
                if (!ttsPlayingRef.current) playNextTTS()
              }
            }
          },
        },
      )
      // Phrase restante
      if (pendingBuffer.trim().length > 2) {
        ttsQueueRef.current.push(pendingBuffer.trim())
        if (!ttsPlayingRef.current) playNextTTS()
      }
      if (response?.error) setError(String(response.error))
      if (assistantFullText.trim()) {
        setConversation(prev => [...prev, { role: 'assistant', text: assistantFullText.trim(), ts: Date.now() }])
      }
    } catch (e: any) {
      console.warn('[VoiceModal] chat error:', e)
      setError(`Chat : ${e?.message || 'inconnu'}`)
      setStatus('error')
      return
    }

    // Attend la fin de la lecture TTS puis relance le mic automatiquement si
    // la session est toujours active (l'user n'a pas cliqué stop).
    const waitForTTS = () => new Promise<void>(resolve => {
      const tick = () => {
        if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0) resolve()
        else setTimeout(tick, 150)
      }
      tick()
    })
    await waitForTTS()

    if (sessionActiveRef.current) {
      // Redémarre l'écoute pour la question suivante
      setTimeout(() => { if (sessionActiveRef.current) startRecording(convoId) }, 300)
    } else {
      setStatus('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider, selectedModel, playNextTTS])

  // ─── Cycle d'enregistrement ────────────────────────────────────────────
  const startRecording = useCallback(async (convoId: number) => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
      streamRef.current = stream
      audioChunksRef.current = []

      let mimeType = ''
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus'
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm'
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4'
      }
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorderRef.current = mr
      convoIdRef.current = convoId
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.start()
      setStatus('recording')
      setRecordingSec(0)
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = window.setInterval(() => setRecordingSec(s => s + 1), 1000)
    } catch (e: any) {
      const msg = e?.name === 'NotAllowedError'
        ? 'Micro bloqué. Vérifie l\'icône cadenas dans la barre d\'adresse.'
        : `Micro : ${e?.message || 'erreur'}`
      setError(msg); setStatus('error'); sessionActiveRef.current = false
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }

    await new Promise<void>((resolve) => {
      mr.onstop = () => resolve()
      try { mr.stop() } catch { resolve() }
    })

    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    mediaRecorderRef.current = null

    const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' })
    audioChunksRef.current = []
    if (!blob.size) {
      // Rien capté (clic trop rapide ?) — retour en idle prêt à réessayer
      setStatus('idle')
      return
    }

    setStatus('transcribing')
    let text = ''
    try {
      text = await transcribeBlob(blob)
    } catch (e: any) {
      console.warn('[VoiceModal] transcribe failed:', e)
      setError(`Transcription : ${e?.message || 'échec'}`); setStatus('error'); return
    }
    if (!text) {
      // Silence ou bruit uniquement — on relance l'écoute sans rien envoyer
      setStatus('idle')
      if (sessionActiveRef.current && convoIdRef.current) {
        setTimeout(() => { if (sessionActiveRef.current) startRecording(convoIdRef.current!) }, 200)
      }
      return
    }
    setConversation(prev => [...prev, { role: 'user', text, ts: Date.now() }])
    await sendToGungnir(text, convoIdRef.current!)
  }, [sendToGungnir, startRecording])

  // ─── Démarrage / arrêt global de la session ────────────────────────────
  const startSession = useCallback(async () => {
    setError(null)

    // S'assure d'avoir une conversation cible pour le chat (création auto sinon)
    let convoId = currentConversation
    if (!convoId) {
      try {
        const newConvo = await api.createConversation({
          title: 'Session vocale',
          provider: selectedProvider,
          model: selectedModel,
        })
        convoId = newConvo.id
        setCurrentConversation(newConvo.id)
      } catch (e: any) {
        setError(`Création conversation : ${e?.message || 'échec'}`); setStatus('error'); return
      }
    }
    convoIdRef.current = convoId

    // Préchauffe le modèle Whisper si pas déjà fait (bloquant pour éviter un
    // 1er enregistrement perdu si le modèle met 20s à DL).
    setStatus('loading-model')
    try {
      await loadTranscriber(pct => setModelProgress(pct))
    } catch (e: any) {
      setError(`Modèle Whisper : ${e?.message || 'chargement échoué'}`); setStatus('error'); return
    }

    sessionActiveRef.current = true
    await startRecording(convoId!)
  }, [currentConversation, selectedProvider, selectedModel, setCurrentConversation, startRecording])

  const endSession = useCallback(() => {
    sessionActiveRef.current = false
    // Stop recording si en cours
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try { mediaRecorderRef.current.stop() } catch { /* ignore */ }
    }
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    mediaRecorderRef.current = null
    // Stop TTS
    if (ttsAudioRef.current) { try { ttsAudioRef.current.pause() } catch { /* ignore */ } ; ttsAudioRef.current = null }
    ttsQueueRef.current = []
    ttsPlayingRef.current = false
    setStatus('idle')
  }, [])

  // ─── Handler du bouton central : toggle selon l'état ───────────────────
  const handleCenterClick = useCallback(() => {
    if (status === 'idle' || status === 'error') {
      startSession()
    } else if (status === 'recording') {
      // Stop recording manuel → lance la transcription immédiatement
      stopRecording()
    } else if (status === 'thinking' || status === 'speaking') {
      // Interrompt la réponse + la lecture + termine la session
      endSession()
      setConversation(prev => prev)
    } else {
      endSession()
    }
  }, [status, startSession, stopRecording, endSession])

  // Barre espace pour toggle session
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); handleCenterClick() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, handleCenterClick])

  const handleClose = () => { endSession(); onClose() }

  const isActive = status !== 'idle' && status !== 'error'

  if (!isOpen) return null

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>
      <div className="relative w-full sm:w-[500px] sm:max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg" style={{ background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)' }}>
              <Brain className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
            </div>
            <div>
              <p className="text-sm font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>Conversation vocale</p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{agentName} — cerveau Gungnir complet</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => setIsMuted(!isMuted)} className="p-1.5 rounded-lg transition-colors"
              style={{ color: isMuted ? 'var(--accent-primary-light)' : 'var(--text-muted)' }}
              title={isMuted ? 'Son coupé' : 'Couper le son de l\'agent'}>
              {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
            <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium mx-1"
              style={{ background: isActive ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--text-muted) 12%, transparent)', color: STATUS_COLOR[status] }}>
              <Radio className="w-2.5 h-2.5" />
              <span className="ml-0.5">{STATUS_LABEL[status]}</span>
            </div>
            <button type="button" onClick={handleClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Info banner — cerveau complet (remplace l'ancien disclaimer Convai) */}
        <div className="mx-4 mt-3 p-2.5 rounded-lg flex items-start gap-2"
          style={{ background: 'color-mix(in srgb, var(--scarlet) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--scarlet) 25%, transparent)' }}>
          <Sparkles className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--scarlet)' }} />
          <p className="text-[10.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: 'var(--scarlet)', fontWeight: 600 }}>Accès complet Gungnir.</span>{' '}
            Ta voix passe par Whisper local (aucune donnée ne sort du navigateur), puis
            ton cerveau principal répond avec skills, conscience, sous-agents, outils et mémoire.
            Lecture TTS via ElevenLabs.
          </p>
        </div>

        {error && (
          <div className="mx-4 mt-3 p-3 rounded-lg flex items-start gap-2"
            style={{ background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-danger) 30%, transparent)' }}>
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-danger)' }} />
            <p className="text-xs" style={{ color: 'var(--accent-danger)' }}>{error}</p>
          </div>
        )}

        {/* Bouton central + status */}
        <div className="flex flex-col items-center justify-center py-8 relative flex-shrink-0">
          {isActive && (
            <div className="absolute inset-0 pointer-events-none"
              style={{ background: 'radial-gradient(ellipse 320px 200px at 50% 50%, color-mix(in srgb, var(--scarlet) 7%, transparent) 0%, transparent 70%)' }} />
          )}
          <div className="relative flex items-center justify-center mb-5">
            {(status === 'recording' ? [0,1,2] : status === 'loading-model' ? [0] : []).map(i => (
              <div key={i} className="absolute rounded-full transition-all duration-150"
                style={{
                  width: 100 + i * 40, height: 100 + i * 40,
                  border: `1px solid color-mix(in srgb, var(--scarlet) ${status === 'recording' ? 35 : 15}%, transparent)`,
                  animation: status === 'recording' ? `vm-pulse ${1.4 + i * 0.35}s ease-in-out infinite` : 'none',
                  animationDelay: `${i * 0.15}s`,
                }} />
            ))}
            <button type="button" onClick={handleCenterClick}
              className="relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 select-none"
              style={{
                background: status === 'recording'
                  ? 'linear-gradient(135deg, var(--scarlet), color-mix(in srgb, var(--scarlet) 60%, black))'
                  : status === 'speaking' || status === 'thinking'
                    ? 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))'
                    : 'linear-gradient(135deg, var(--bg-tertiary), var(--bg-secondary))',
                border: `2px solid ${status === 'recording' ? 'var(--accent-danger)' : 'var(--border)'}`,
                boxShadow: isActive ? '0 0 30px color-mix(in srgb, var(--scarlet) 30%, transparent)' : 'none',
              }}
              title={status === 'idle' ? 'Démarrer (Espace)' : 'Arrêter / interrompre (Espace)'}>
              {status === 'idle' && <Mic className="w-7 h-7" style={{ color: 'var(--text-primary)' }} />}
              {status === 'loading-model' && <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--accent-tertiary)' }} />}
              {status === 'recording' && <Square className="w-6 h-6 animate-pulse" fill="currentColor" style={{ color: 'var(--text-primary)' }} />}
              {status === 'transcribing' && <Loader2 className="w-7 h-7 animate-spin" style={{ color: 'var(--text-primary)' }} />}
              {status === 'thinking' && <Sparkles className="w-7 h-7 animate-pulse" style={{ color: 'var(--text-primary)' }} />}
              {status === 'speaking' && <Volume2 className="w-7 h-7" style={{ color: 'var(--text-primary)', opacity: 0.9 }} />}
              {status === 'error' && <Mic className="w-7 h-7" style={{ color: 'var(--text-muted)' }} />}
            </button>
          </div>
          <p className="text-xs font-medium text-center px-6" style={{ color: STATUS_COLOR[status] }}>{STATUS_LABEL[status]}</p>
          <p className="text-[10px] mt-1 tabular-nums" style={{ color: 'var(--border)' }}>
            {status === 'loading-model' && modelProgress > 0 && `${modelProgress}%`}
            {status === 'recording' && `${formatTime(recordingSec)} · Clic ou Espace pour arrêter`}
            {status === 'idle' && 'Clic ou Espace pour démarrer'}
          </p>
        </div>

        {/* Transcript conversation */}
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

        {/* Footer info */}
        <div className="px-5 py-2.5 border-t flex-shrink-0 flex items-center justify-center" style={{ borderColor: 'var(--bg-secondary)' }}>
          <span className="text-[10px]" style={{ color: 'var(--border)' }}>Whisper local · Gungnir · TTS ElevenLabs · Espace pour démarrer/arrêter</span>
        </div>
      </div>

      <style>{`@keyframes vm-pulse { 0%, 100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.08); opacity: 0.3; } }`}</style>
    </div>
  )
}
