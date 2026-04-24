/**
 * whisper.ts — Wrapper partagé autour de @xenova/transformers (Whisper WASM).
 *
 * Le modèle est chargé UNE SEULE FOIS (promise singleton) et mis en cache
 * IndexedDB par transformers.js. Tous les composants qui en ont besoin
 * (VoiceInput dans le chat, VoiceModal pour le mode conversation vocale)
 * partagent la même instance — donc pas de double download.
 */

// Modèle par défaut : whisper-base (~80 MB, bon compromis vitesse/qualité FR).
// Switch à 'Xenova/whisper-tiny' (~40 MB) si tu veux de la vitesse au détriment
// de la précision, ou 'Xenova/whisper-small' (~240 MB) pour la qualité max.
export const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-base'
export const DEFAULT_WHISPER_LANGUAGE = 'french'

let transcriberPromise: Promise<any> | null = null

/** Charge (ou retourne) le transcriber Whisper. Idempotent. */
export function loadTranscriber(onProgress?: (pct: number) => void): Promise<any> {
  if (transcriberPromise) return transcriberPromise
  transcriberPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers')
    env.allowLocalModels = false
    env.backends.onnx.wasm.numThreads = 1
    return pipeline('automatic-speech-recognition', DEFAULT_WHISPER_MODEL, {
      quantized: true,
      progress_callback: (p: any) => {
        if (p?.status === 'progress' && typeof p.progress === 'number' && onProgress) {
          onProgress(Math.round(p.progress))
        }
      },
    } as any)
  })().catch((e) => {
    transcriberPromise = null  // retry possible après échec
    throw e
  })
  return transcriberPromise
}

/**
 * Décode un blob audio (webm/opus ou mp4) vers un Float32Array mono 16 kHz
 * (le format qu'attend Whisper), puis lance la transcription.
 */
export async function transcribeBlob(
  blob: Blob,
  options: { language?: string; onModelProgress?: (pct: number) => void } = {},
): Promise<string> {
  const transcriber = await loadTranscriber(options.onModelProgress)

  const arrayBuffer = await blob.arrayBuffer()
  const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext
  const audioCtx = new Ctx({ sampleRate: 16000 })
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0))
  let samples = audioBuffer.getChannelData(0)

  // Downsample naïf si le navigateur a ignoré sampleRate: 16000
  if (audioBuffer.sampleRate !== 16000) {
    const ratio = audioBuffer.sampleRate / 16000
    const targetLen = Math.floor(samples.length / ratio)
    const resampled = new Float32Array(targetLen)
    for (let i = 0; i < targetLen; i++) resampled[i] = samples[Math.floor(i * ratio)]
    samples = resampled
  }
  try { audioCtx.close() } catch { /* ignore */ }

  const result = await transcriber(samples, {
    language: options.language || DEFAULT_WHISPER_LANGUAGE,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  })
  return (result?.text || '').trim()
}
