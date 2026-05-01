import { useState, useEffect } from 'react'
import { Mail, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { api } from '../services/api'

export default function VerifyEmail() {
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [verifiedEmail, setVerifiedEmail] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token') || ''
    if (!token) {
      setState('error')
      setMessage("Lien invalide : token manquant")
      return
    }
    api.verifyEmail(token)
      .then(res => {
        if (res?.ok) {
          setState('success')
          setVerifiedEmail(res.email || '')
        } else {
          setState('error')
          setMessage(res?.error || 'Erreur de vérification')
        }
      })
      .catch(err => {
        setState('error')
        setMessage(err?.message || err?.error || 'Lien invalide ou expiré')
      })
  }, [])

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-sm p-8 rounded-2xl text-center" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
          style={{
            background: state === 'success' ? '#22c55e' : state === 'error' ? '#ef4444' : 'var(--accent-primary)',
          }}>
          {state === 'loading'
            ? <Loader2 className="w-7 h-7 text-white animate-spin" />
            : state === 'success'
              ? <CheckCircle2 className="w-7 h-7 text-white" />
              : <AlertCircle className="w-7 h-7 text-white" />}
        </div>
        <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {state === 'loading' ? 'Vérification...'
            : state === 'success' ? 'Email confirmé'
            : 'Vérification échouée'}
        </h1>
        <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
          {state === 'loading' && "On valide ton lien..."}
          {state === 'success' && (verifiedEmail
            ? <>L'adresse <strong>{verifiedEmail}</strong> est maintenant confirmée. Tu peux récupérer ton mot de passe par mail si besoin.</>
            : "Ton adresse est confirmée.")}
          {state === 'error' && (message || "Le lien est invalide ou a expiré.")}
        </p>
        <div className="mt-6">
          <a href="/" className="inline-block px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ background: 'var(--accent-primary)' }}>
            <Mail className="inline w-4 h-4 mr-2" />
            Continuer vers Gungnir
          </a>
        </div>
      </div>
    </div>
  )
}
