import { useState, useEffect } from 'react'
import { Lock, AlertCircle, CheckCircle2 } from 'lucide-react'
import { api } from '../services/api'

export default function ResetPassword() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const t = params.get('token') || ''
    if (!t) setError("Lien invalide : token manquant")
    setToken(t)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError("Mot de passe trop court (minimum 8 caractères)"); return }
    if (password !== confirm) { setError("Les deux mots de passe ne correspondent pas"); return }
    if (!token) { setError("Token manquant"); return }
    setLoading(true)
    try {
      await api.resetPassword({ token, password })
      setDone(true)
      setTimeout(() => { window.location.href = '/' }, 2500)
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
            <Lock className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Nouveau mot de passe</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Choisis un nouveau mot de passe pour ton compte.
          </p>
        </div>

        {done ? (
          <div className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
            <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              Mot de passe mis à jour. Redirection vers la page de connexion...
            </div>
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
                  Nouveau mot de passe
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    minLength={8}
                    className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    placeholder="••••••••"
                    autoFocus
                  />
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Minimum 8 caractères.</p>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Confirmer le mot de passe
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="password"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    placeholder="••••••••"
                  />
                </div>
              </div>
              <button type="submit" disabled={loading || !token}
                className="w-full py-2.5 rounded-lg text-sm font-medium text-white transition-opacity"
                style={{ background: 'var(--accent-primary)', opacity: (loading || !token) ? 0.5 : 1 }}>
                {loading ? 'Mise à jour...' : 'Mettre à jour le mot de passe'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
