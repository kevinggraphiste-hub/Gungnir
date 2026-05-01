import { useState } from 'react'
import { Mail, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react'
import { api } from '../services/api'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !email.includes('@')) {
      setError("Entre une adresse email valide")
      return
    }
    setLoading(true)
    try {
      // Le backend renvoie toujours 200 OK pour ne pas révéler l'existence
      // d'un compte (anti-enumeration). Donc on affiche le succès dans tous
      // les cas, l'utilisateur n'a pas besoin de savoir si son email existe.
      await api.forgotPassword(email.trim().toLowerCase())
      setSent(true)
    } catch (err: any) {
      setError(err?.message || err?.error || 'Erreur')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-sm p-8 rounded-2xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-center mb-6">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-primary)' }}>
            <Mail className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Mot de passe oublié</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            On t'envoie un lien pour le réinitialiser.
          </p>
        </div>

        {sent ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
              <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                Si un compte existe pour <strong>{email}</strong>, un email contenant un lien de réinitialisation vient d'être envoyé. Le lien expire dans 1 heure.
              </div>
            </div>
            <a href="/" className="flex items-center justify-center gap-2 text-sm transition-opacity hover:opacity-80"
              style={{ color: 'var(--accent-primary)' }}>
              <ArrowLeft className="w-4 h-4" /> Retour à la connexion
            </a>
          </div>
        ) : (
          <>
            {error && (
              <div className="flex items-center gap-2 p-3 mb-4 rounded-lg text-sm" style={{ background: 'rgba(220,38,38,0.1)', color: '#ef4444' }}>
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Adresse email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    placeholder="vous@exemple.com"
                    autoFocus
                  />
                </div>
              </div>
              <button type="submit" disabled={loading || !email.trim()}
                className="w-full py-2.5 rounded-lg text-sm font-medium text-white transition-opacity"
                style={{ background: 'var(--accent-primary)', opacity: (loading || !email.trim()) ? 0.5 : 1 }}>
                {loading ? 'Envoi...' : 'Envoyer le lien de réinitialisation'}
              </button>
            </form>
            <div className="mt-5 text-center">
              <a href="/" className="text-xs transition-opacity hover:opacity-80"
                style={{ color: 'var(--text-muted)' }}>
                Retour à la connexion
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
