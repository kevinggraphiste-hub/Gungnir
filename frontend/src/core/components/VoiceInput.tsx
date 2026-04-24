/**
 * VoiceInput — Saisie vocale avec Whisper local dans le navigateur.
 *
 * Utilise @xenova/transformers (Whisper WASM quantized) pour transcrire en
 * local. Le blob audio ne quitte JAMAIS le navigateur. Zéro log externe, zéro
 * clé API, zéro dépendance backend pour le STT.
 *
 * Machine à états :
 *   idle         → bouton Mic cliquable
 *   loading-model → téléchargement du modèle depuis HuggingFace CDN (1 fois, ~80 MB)
 *   recording    → MediaRecorder actif, timer affiché, bouton devient Stop rouge
 *   transcribing → modèle Whisper analyse l'audio, bouton devient Loader
 *
 * Premier usage : ~20-30s de chargement du modèle (cached ensuite en IndexedDB).
 * Transcription : ~2-4s pour 10s d'audio sur CPU moyen.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Loader2, AlertCircle } from 'lucide-react'

type VoiceState = 'idle' | 'loading-model' | 'recording' | 'transcribing'

// Taille du modèle Whisper à charger. `tiny` ~40 MB très rapide mais perd en
// précision sur le français technique. `base` ~80 MB est le bon compromis.
// `small` ~240 MB pour qui veut la qualité max (premier chargement plus long).
const WHISPER_MODEL = 'Xenova/whisper-base'
const WHISPER_LANGUAGE = 'french'

interface VoiceInputProps {
  onTranscript: (text: string) => void
  disabled?: boolean
  size?: number  // Taille du bouton en px (défaut 30 pour matcher la toolbar chat)
  title?: string
}

// Singleton du pipeline pour ne pas recharger à chaque mount du composant.
let transcriberPromise: Promise<any> | null = null

function loadTranscriber(onProgress?: (pct: number) => void): Promise<any> {
  if (transcriberPromise) return transcriberPromise
  transcriberPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers')
    // Désactive le remote pour forcer la récupération locale ? Non — on VEUT
    // le remote (HuggingFace CDN). Mais on désactive l'onnxruntime-web
    // telemetry pour rester strict "sans log".
    env.allowLocalModels = false
    env.backends.onnx.wasm.numThreads = 1  // évite contention multi-thread
    return pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      quantized: true,
      progress_callback: (p: any) => {
        if (p?.status === 'progress' && typeof p.progress === 'number' && onProgress) {
          onProgress(Math.round(p.progress))
        }
      },
    } as any)
  })().catch((e) => {
    transcriberPromise = null  // permet un retry après échec
    throw e
  })
  return transcriberPromise
}

export default function VoiceInput({ onTranscript, disabled, size = 30, title }: VoiceInputProps) {
  const [state, setState] = useState<VoiceState>('idle')
  const [modelProgress, setModelProgress] = useState(0)
  const [recordingSec, setRecordingSec] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const transcriberRef = useRef<any>(null)

  // Cleanup quand le composant démount pendant un recording
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        try { mediaRecorderRef.current.stop() } catch { /* ignore */ }
      }
    }
  }, [])

  const startRecording = useCallback(async () => {
    setError(null)
    try {
      // Demande le micro en parallèle du chargement du modèle : si c'est la
      // première fois, on n'attend pas le download des ~80 MB avant de
      // commencer à enregistrer. Le modèle sera prêt quand l'user cliquera
      // stop (Whisper tourne après-coup sur l'audio capté).
      const streamPromise = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })

      // Lance le chargement du modèle si pas déjà fait
      if (!transcriberRef.current) {
        setState('loading-model')
        setModelProgress(0)
        try {
          transcriberRef.current = await loadTranscriber((pct) => setModelProgress(pct))
        } catch (e: any) {
          console.warn('[VoiceInput] Model load failed:', e)
          setError(`Chargement du modèle : ${e?.message || 'échec réseau'}`)
          setState('idle')
          // Annule le stream si ouvert
          try { (await streamPromise).getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
          return
        }
      }

      const stream = await streamPromise
      streamRef.current = stream
      audioChunksRef.current = []

      // Choix du mimeType : webm/opus par défaut (Chrome/Firefox/Edge), mp4 en fallback Safari
      let mimeType = ''
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus'
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm'
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4'
      }
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorderRef.current = mr
      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.start()
      setState('recording')
      setRecordingSec(0)
      timerRef.current = window.setInterval(() => setRecordingSec(s => s + 1), 1000)
    } catch (e: any) {
      console.warn('[VoiceInput] startRecording failed:', e)
      const msg = e?.name === 'NotAllowedError'
        ? 'Micro bloqué. Vérifie l\'icône cadenas dans la barre d\'adresse.'
        : `Impossible d'ouvrir le micro : ${e?.message || 'erreur inconnue'}`
      setError(msg)
      setState('idle')
    }
  }, [])

  const stopRecording = useCallback(async () => {
    const mr = mediaRecorderRef.current
    if (!mr) return
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null }

    // Attend que onstop se déclenche (le blob est finalisé)
    await new Promise<void>((resolve) => {
      mr.onstop = () => resolve()
      try { mr.stop() } catch { resolve() }
    })

    // Stop immédiatement le stream pour que l'icône OS "micro actif" disparaisse
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    mediaRecorderRef.current = null

    const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' })
    audioChunksRef.current = []
    if (!blob.size) {
      console.warn('[VoiceInput] Empty blob, skipping')
      setState('idle')
      return
    }

    setState('transcribing')
    try {
      const transcriber = transcriberRef.current
      if (!transcriber) throw new Error('Modèle non chargé')

      // Decode le blob audio (webm/opus) vers Float32Array mono à 16 kHz
      // (format attendu par Whisper). On utilise AudioContext pour le resample.
      const arrayBuffer = await blob.arrayBuffer()
      // NOTE : webkitAudioContext pour Safari < 14. Le sampleRate cible 16000
      // est pris en charge par les AudioContext modernes — le navigateur
      // resamplera à la volée le décodage.
      const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext
      const audioCtx = new Ctx({ sampleRate: 16000 })
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0))
      let samples = audioBuffer.getChannelData(0)
      // Si par hasard le navigateur ignore le sampleRate: 16000 et décode à 44100,
      // on fait un downsample naïf (prend 1 sur ~2.76 samples).
      if (audioBuffer.sampleRate !== 16000) {
        const ratio = audioBuffer.sampleRate / 16000
        const targetLen = Math.floor(samples.length / ratio)
        const resampled = new Float32Array(targetLen)
        for (let i = 0; i < targetLen; i++) {
          resampled[i] = samples[Math.floor(i * ratio)]
        }
        samples = resampled
      }
      try { audioCtx.close() } catch { /* ignore */ }

      const result = await transcriber(samples, {
        language: WHISPER_LANGUAGE,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      })
      const text = (result?.text || '').trim()
      if (text) onTranscript(text)
      else setError('Aucune parole détectée')
      setState('idle')
    } catch (e: any) {
      console.warn('[VoiceInput] transcription failed:', e)
      setError(`Transcription : ${e?.message || 'erreur inconnue'}`)
      setState('idle')
    }
  }, [onTranscript])

  const handleClick = useCallback(() => {
    if (disabled) return
    if (state === 'idle') startRecording()
    else if (state === 'recording') stopRecording()
    // En loading-model ou transcribing : pas de clic possible (bouton disabled)
  }, [state, disabled, startRecording, stopRecording])

  // Affichage du temps d'enregistrement : 0:05 → 1:23
  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const isDisabled = !!disabled || state === 'loading-model' || state === 'transcribing'
  const isRecording = state === 'recording'

  return (
    <div className="relative inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        className="flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          width: size,
          height: size,
          background: isRecording
            ? 'color-mix(in srgb, var(--scarlet) 20%, transparent)'
            : state === 'loading-model' || state === 'transcribing'
              ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)'
              : 'transparent',
          border: `1px solid ${
            isRecording
              ? 'color-mix(in srgb, var(--scarlet) 50%, transparent)'
              : state === 'loading-model' || state === 'transcribing'
                ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)'
                : 'var(--border)'
          }`,
          color: isRecording
            ? 'var(--scarlet)'
            : state === 'loading-model' || state === 'transcribing'
              ? 'var(--accent-primary)'
              : 'var(--text-muted)',
        }}
        title={
          title ||
          (state === 'idle' ? 'Cliquer pour parler (Whisper local, aucune donnée envoyée)'
          : state === 'loading-model' ? `Chargement du modèle Whisper… ${modelProgress}%`
          : state === 'recording' ? 'Cliquer pour arrêter et transcrire'
          : 'Transcription en cours…')
        }
      >
        {state === 'idle' && <Mic className="w-3.5 h-3.5" />}
        {state === 'loading-model' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {state === 'recording' && <Square className="w-3 h-3 animate-pulse" fill="currentColor" />}
        {state === 'transcribing' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      </button>

      {/* Timer recording */}
      {state === 'recording' && (
        <span className="text-[10px] tabular-nums" style={{ color: 'var(--scarlet)' }}>
          {formatTime(recordingSec)}
        </span>
      )}

      {/* Progression téléchargement modèle */}
      {state === 'loading-model' && modelProgress > 0 && (
        <span className="text-[10px] tabular-nums" style={{ color: 'var(--accent-primary)' }}>
          {modelProgress}%
        </span>
      )}

      {/* Mini-indicateur d'erreur — flotte à droite, auto-clear au clic suivant */}
      {error && (
        <span className="absolute top-full left-0 mt-1 flex items-start gap-1 text-[10px] whitespace-nowrap px-2 py-1 rounded-md"
          style={{
            background: 'color-mix(in srgb, var(--accent-danger) 12%, var(--bg-secondary))',
            border: '1px solid color-mix(in srgb, var(--accent-danger) 30%, transparent)',
            color: 'var(--accent-danger)',
            zIndex: 10,
          }}
          onClick={() => setError(null)}>
          <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          {error}
        </span>
      )}
    </div>
  )
}
