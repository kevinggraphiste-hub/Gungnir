import { useState, useEffect } from 'react'
import { LogIn, User, Lock, Mail, AlertCircle, UserPlus } from 'lucide-react'
import { api } from '../services/api'

interface Props {
  onLogin: (user: any) => void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function Login({ onLogin }: Props) {
  // identifier = email OU pseudo. Le backend route automatiquement selon
  // la présence d'un "@" dans la chaîne (option B hybride).
  const [identifier, setIdentifier] = useState('')
  const [emailField, setEmailField] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'login' | 'setup' | 'register'>('login')
  const [hasUsers, setHasUsers] = useState(true)

  useEffect(() => {
    const check = async () => {
      try {
        const users = await api.getUsers()
        if (!users || users.length === 0) {
          setMode('setup')
          setHasUsers(false)
        }
      } catch { /* ignore */ }
    }
    check()
  }, [])

  const isRegisterMode = mode === 'setup' || mode === 'register'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (isRegisterMode) {
      if (!username.trim()) { setError("Choisis un nom d'utilisateur"); return }
      if (!password) { setError("Mot de passe requis"); return }
      if (emailField && !EMAIL_RE.test(emailField.trim())) {
        setError("Format d'email invalide")
        return
      }
    } else {
      if (!identifier.trim()) { setError("Email ou nom d'utilisateur requis"); return }
    }

    setLoading(true)
    try {
      if (isRegisterMode) {
        await api.createUser({
          username: username.trim(),
          display_name: username.trim(),
          email: emailField.trim() || undefined,
          password,
        })
        // Après register : auto-login avec username + password
        const result = await api.loginUser({ username: username.trim(), password })
        if (result.ok && result.user) {
          localStorage.setItem('gungnir_current_user', JSON.stringify(result.user))
          onLogin(result.user)
        }
      } else {
        // Login : router le champ identifier en email ou username
        const id = identifier.trim()
        const isEmail = id.includes('@')
        let result: any
        try {
          result = await api.loginUser(
            isEmail ? { email: id, password } : { username: id, password }
          )
        } catch (err: any) {
          // Compat passwordless legacy : si le backend dit "pas de mdp", retry sans
          const msg = String(err?.message || err?.error || '')
          if (msg.toLowerCase().includes("pas de mot de passe") && password) {
            result = await api.loginUser(
              isEmail ? { email: id, password: '' } : { username: id, password: '' }
            )
          } else {
            throw err
          }
        }
        if (result.ok && result.user) {
          localStorage.setItem('gungnir_current_user', JSON.stringify(result.user))
          onLogin(result.user)
        }
      }
    } catch (err: any) {
      const msg = err?.message || err?.error || 'Erreur de connexion'
      if (msg.includes('existe déjà')) {
        setError("Ce nom d'utilisateur est déjà pris. Choisissez-en un autre.")
      } else if (msg.includes('email') && msg.includes('utilisée')) {
        setError("Cette adresse email est déjà utilisée par un autre compte.")
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const canSubmit = (() => {
    if (loading) return false
    if (isRegisterMode) return !!username.trim() && !!password
    return !!identifier.trim()
  })()

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-primary)' }}>
      <div className="w-full max-w-sm p-8 rounded-2xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style={{ background: 'var(--accent-primary)' }}>
            <span className="text-2xl font-bold text-white">G</span>
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Gungnir</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {mode === 'setup' ? 'Créer votre compte administrateur'
              : mode === 'register' ? 'Créer votre compte'
              : 'Connexion requise'}
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 mb-4 rounded-lg text-sm" style={{ background: 'rgba(220,38,38,0.1)', color: '#ef4444' }}>
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegisterMode ? (
            <>
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Nom d'utilisateur
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    placeholder="Choisissez un pseudo"
                    autoFocus
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Email <span style={{ color: 'var(--text-muted)' }}>(optionnel mais recommandé)</span>
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                  <input
                    type="email"
                    value={emailField}
                    onChange={e => setEmailField(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    placeholder="vous@exemple.com"
                  />
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Nécessaire pour récupérer votre mot de passe en cas d'oubli.
                </p>
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Email ou nom d'utilisateur
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  value={identifier}
                  onChange={e => setIdentifier(e.target.value)}
                  className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  placeholder="vous@exemple.com ou pseudo"
                  autoFocus
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Mot de passe {!isRegisterMode && <span style={{ color: 'var(--text-muted)' }}>(si défini)</span>}
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-muted)' }} />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm outline-none"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                placeholder="••••••••"
                minLength={isRegisterMode ? 8 : undefined}
              />
            </div>
            {isRegisterMode && (
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Minimum 8 caractères.
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-2.5 rounded-lg text-sm font-medium text-white flex items-center justify-center gap-2 transition-opacity"
            style={{ background: 'var(--accent-primary)', opacity: canSubmit ? 1 : 0.5 }}
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : isRegisterMode ? (
              <UserPlus className="w-4 h-4" />
            ) : (
              <LogIn className="w-4 h-4" />
            )}
            {loading ? 'Connexion...' : isRegisterMode ? 'Créer et se connecter' : 'Se connecter'}
          </button>
        </form>

        {/* Forgot password — login mode only */}
        {mode === 'login' && (
          <div className="mt-3 text-center">
            <a href="/forgot-password"
              className="text-xs transition-opacity hover:opacity-80"
              style={{ color: 'var(--text-muted)' }}>
              Mot de passe oublié ?
            </a>
          </div>
        )}

        {hasUsers && mode !== 'setup' && (
          <div className="mt-5 text-center">
            <button
              type="button"
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}
              className="text-xs transition-opacity hover:opacity-80"
              style={{ color: 'var(--accent-primary)' }}
            >
              {mode === 'login' ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
