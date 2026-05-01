import { useState, useEffect } from 'react'
import { X, User, Plus, Trash2, Pencil, Check, AlertTriangle, Mail } from 'lucide-react'
import { api, clearAuthToken } from '../services/api'

interface UserData {
  id: number
  username: string
  display_name: string
  avatar_url: string
  is_active: boolean
}

interface MeInfo {
  email: string | null
  email_verified: boolean
  pending_email: string | null
}

interface Props {
  isOpen: boolean
  onClose: () => void
  currentUser: UserData | null
  onUserChange: (user: UserData | null) => void
}

export default function UserModal({ isOpen, onClose, currentUser, onUserChange }: Props) {
  const [users, setUsers] = useState<UserData[]>([])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState({ display_name: '', password: '', avatar_url: '' })
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ username: '', display_name: '', password: '', avatar_url: '' })
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [showLogin, setShowLogin] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  // Self-delete : double confirmation pour éviter le clic compulsif. L'user
  // doit ouvrir le panneau (showSelfDelete) puis taper le mot magique
  // "supprimer" exact avant que le bouton rouge soit actif.
  const [showSelfDelete, setShowSelfDelete] = useState(false)
  const [selfDeleteConfirm, setSelfDeleteConfirm] = useState('')
  const [me, setMe] = useState<MeInfo | null>(null)
  const [showEmailEdit, setShowEmailEdit] = useState(false)
  const [newEmail, setNewEmail] = useState('')

  useEffect(() => {
    if (!isOpen) return
    loadUsers()
    loadMe()
  }, [isOpen])

  const loadUsers = async () => {
    try { const data = await api.getUsers(); setUsers(data) } catch { /* ignore */ }
  }

  const loadMe = async () => {
    try {
      const r = await api.checkAuth()
      if (r.ok && r.user) {
        setMe({
          email: r.user.email ?? null,
          email_verified: !!r.user.email_verified,
          pending_email: r.user.pending_email ?? null,
        })
      }
    } catch { /* ignore */ }
  }

  const handleChangeEmail = async () => {
    const trimmed = newEmail.trim().toLowerCase()
    if (!trimmed.includes('@')) { setMessage({ type: 'err', text: "Format d'email invalide" }); return }
    setLoading(true)
    try {
      await api.changeEmail(trimmed)
      await loadMe()
      setShowEmailEdit(false)
      setNewEmail('')
      setMessage({ type: 'ok', text: "Email enregistré. Clique sur le lien reçu par mail pour confirmer." })
    } catch (err: any) {
      setMessage({ type: 'err', text: err?.message || err?.error || 'Erreur' })
    } finally { setLoading(false) }
  }

  const handleResendVerification = async () => {
    setLoading(true)
    try {
      await api.resendVerification()
      setMessage({ type: 'ok', text: "Email de vérification renvoyé. Vérifie ta boîte (et les spams)." })
    } catch (err: any) {
      setMessage({ type: 'err', text: err?.message || err?.error || 'Erreur' })
    } finally { setLoading(false) }
  }

  const handleCreate = async () => {
    if (!createForm.username.trim()) return
    setLoading(true)
    try {
      const user = await api.createUser({
        username: createForm.username.trim(),
        display_name: createForm.display_name.trim() || createForm.username.trim(),
        password: createForm.password || undefined,
        avatar_url: createForm.avatar_url || undefined,
      })
      setUsers(prev => [...prev, user])
      setShowCreate(false)
      setCreateForm({ username: '', display_name: '', password: '', avatar_url: '' })
      // ⚠️ Do NOT auto-switch the current user here: without rotating the
      // Bearer token, the backend keeps authenticating the admin that made
      // the call, so every "test" action would silently land on the admin's
      // account. The user can either log in as the new user themselves
      // (with their password) or use the "Tester en tant que" button on the
      // new user's row, which hits /users/{id}/impersonate.
      setMessage({ type: 'ok', text: `Profil "${user.display_name || user.username}" créé. Utilise « Tester en tant que » pour t'y connecter.` })
      setTimeout(() => setMessage(null), 3500)
    } catch (err: any) { setMessage({ type: 'err', text: err.message }) }
    setLoading(false)
  }

  const handleImpersonate = async (user: UserData) => {
    if (!confirm(`Te connecter en tant que « ${user.display_name || user.username} » ? Tu seras redirigé et ton token actuel sera remplacé.`)) return
    setLoading(true)
    try {
      const result = await api.impersonateUser(user.id)
      // api.impersonateUser already called setAuthToken with the new token.
      // Update the local current user pointer and force a full page reload so
      // every cached piece of UI state (conversations, skills, heartbeat,
      // consciousness, etc.) reloads under the new identity.
      onUserChange(result.user)
      localStorage.setItem('gungnir_current_user', JSON.stringify(result.user))
      // Clear any other per-user cached keys so nothing leaks from the old session
      const userScoped = [
        'gungnir_favorite_models', 'gungnir_titles_generated',
        'gungnir_provider', 'gungnir_model', 'gungnir_agent_name',
        'consciousness.introOpen',
      ]
      userScoped.forEach(k => { try { localStorage.removeItem(k) } catch {} })
      window.location.href = '/'
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message })
      setLoading(false)
    }
  }

  const handleUpdate = async (id: number) => {
    setLoading(true)
    try {
      const data: any = {}
      if (editForm.display_name) data.display_name = editForm.display_name
      if (editForm.password) data.password = editForm.password
      if (editForm.avatar_url !== undefined) data.avatar_url = editForm.avatar_url
      await api.updateUser(id, data)
      await loadUsers()
      setEditingId(null)
      setMessage({ type: 'ok', text: 'Profil mis à jour' })
      setTimeout(() => setMessage(null), 2000)
    } catch (err: any) { setMessage({ type: 'err', text: err.message }) }
    setLoading(false)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Supprimer cet utilisateur ?')) return
    try {
      await api.deleteUser(id)
      setUsers(prev => prev.filter(u => u.id !== id))
      if (currentUser?.id === id) onUserChange(null)
      setMessage({ type: 'ok', text: 'Utilisateur supprimé' })
    } catch (err: any) { setMessage({ type: 'err', text: err.message }) }
  }

  const handleLogin = async () => {
    if (!loginForm.username.trim()) return
    setLoading(true)
    try {
      const result = await api.loginUser({ username: loginForm.username.trim(), password: loginForm.password })
      onUserChange(result.user)
      localStorage.setItem('gungnir_current_user', JSON.stringify(result.user))
      setShowLogin(false)
      setLoginForm({ username: '', password: '' })
      setMessage({ type: 'ok', text: `Connecté en tant que ${result.user.display_name}` })
      setTimeout(() => setMessage(null), 2000)
    } catch (err: any) { setMessage({ type: 'err', text: err.message }) }
    setLoading(false)
  }

  // NOTE: cosmetic "select user" is deliberately removed. It used to just
  // flip the currentUser pointer in localStorage without touching the
  // Bearer token — so the UI looked like a different user but every API
  // call was still authenticated as the originator, silently writing the
  // originator's data. Use handleImpersonate (admin-only) to actually
  // switch identities, or log in via handleLogin with real credentials.

  const handleLogout = () => {
    // Real logout: drop the Bearer token AND the cached current user so no
    // request can keep leaking as the previous identity.
    clearAuthToken()
    onUserChange(null)
    localStorage.removeItem('gungnir_current_user')
    setMessage({ type: 'ok', text: 'Déconnecté' })
    setTimeout(() => {
      setMessage(null)
      window.location.href = '/'
    }, 800)
  }

  const handleSelfDelete = async () => {
    if (selfDeleteConfirm !== 'supprimer') return
    setLoading(true)
    try {
      await api.deleteMyAccount()
      // Compte supprimé : on dégage le token + cache local et on redirige
      // vers / (qui repassera par le flow de login).
      clearAuthToken()
      onUserChange(null)
      const userKeys = [
        'gungnir_current_user', 'gungnir_favorite_models', 'gungnir_chat_sidebar',
        'gungnir_titles_generated', 'gungnir_provider', 'gungnir_model',
        'gungnir_agent_name', 'gungnir_theme', 'gungnir_fontsize',
        'gungnir_custom_theme', 'gungnir_ui_prefs',
      ]
      userKeys.forEach(k => { try { localStorage.removeItem(k) } catch {} })
      setMessage({ type: 'ok', text: 'Compte supprimé. Redirection…' })
      setTimeout(() => { window.location.href = '/' }, 1200)
    } catch (err: any) {
      setMessage({ type: 'err', text: err.message || 'Erreur lors de la suppression' })
      setLoading(false)
    }
  }

  const startEditing = (user: UserData) => {
    setEditingId(user.id)
    setEditForm({ display_name: user.display_name, password: '', avatar_url: user.avatar_url || '' })
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full md:max-w-lg rounded-t-2xl md:rounded-2xl shadow-2xl max-h-[92dvh] md:max-h-[85vh] flex flex-col"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg" style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>
              <User className="w-5 h-5" style={{ color: 'var(--accent-primary-light)' }} />
            </div>
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Utilisateurs</h2>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {currentUser ? `Connecté: ${currentUser.display_name}` : 'Aucun profil sélectionné'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg transition-colors" style={{ color: 'var(--text-muted)' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Message */}
        {message && (
          <div className="mx-6 mt-4 px-3 py-2 rounded-lg text-sm flex items-center gap-2"
            style={{
              background: message.type === 'ok' ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
              color: message.type === 'ok' ? 'var(--accent-success)' : 'var(--accent-primary-light)',
              border: message.type === 'ok' ? '1px solid color-mix(in srgb, var(--accent-success) 30%, transparent)' : '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
            }}>
            {message.type === 'ok' ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
            {message.text}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {currentUser && (
            <div className="flex items-center justify-between p-3 rounded-xl"
              style={{ background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm"
                  style={{ background: 'linear-gradient(to bottom right, var(--accent-primary), var(--accent-secondary))', color: 'var(--text-primary)' }}>
                  {currentUser.avatar_url
                    ? <img src={currentUser.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                    : currentUser.display_name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{currentUser.display_name}</div>
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>@{currentUser.username}</div>
                </div>
              </div>
              <button onClick={handleLogout} className="px-3 py-1.5 text-xs rounded-lg transition-colors"
                style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>Déconnecter</button>
            </div>
          )}

          {/* Section email du compte courant : affiche l'email actuel + statut
              vérifié, permet d'en ajouter un (si jamais saisi) ou de changer
              (re-vérification obligatoire pour anti-hijack). */}
          {currentUser && me && (
            <div className="rounded-xl p-3"
              style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-2 mb-2">
                <Mail className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  Email
                </span>
                {me.email && (
                  me.email_verified ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                      style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
                      vérifié
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                      style={{ background: 'rgba(234,179,8,0.15)', color: '#eab308' }}>
                      non vérifié
                    </span>
                  )
                )}
              </div>

              {!showEmailEdit ? (
                <div className="space-y-2">
                  {me.email ? (
                    <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{me.email}</div>
                  ) : (
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Aucun email associé. Ajoutes-en un pour activer la récupération de mot de passe.
                    </div>
                  )}
                  {me.pending_email && (
                    <div className="text-xs px-2 py-1.5 rounded"
                      style={{ background: 'rgba(234,179,8,0.1)', color: '#eab308' }}>
                      Changement en attente : <strong>{me.pending_email}</strong> — clique sur le lien reçu par mail pour confirmer.
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => { setShowEmailEdit(true); setNewEmail('') }}
                      className="px-3 py-1.5 text-xs rounded-lg"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      {me.email ? 'Changer' : 'Ajouter'}
                    </button>
                    {me.email && !me.email_verified && (
                      <button onClick={handleResendVerification} disabled={loading}
                        className="px-3 py-1.5 text-xs rounded-lg disabled:opacity-50"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                        Renvoyer la vérification
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input type="email" placeholder="vous@exemple.com" value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Tu recevras un lien de confirmation. {me.email && me.email_verified
                      ? "Ton email actuel reste actif tant que le nouveau n'est pas confirmé."
                      : ""}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={handleChangeEmail} disabled={loading || !newEmail.trim()}
                      className="px-3 py-1.5 text-xs rounded-lg text-white disabled:opacity-50"
                      style={{ background: 'var(--accent-primary)' }}>
                      Envoyer le lien
                    </button>
                    <button onClick={() => { setShowEmailEdit(false); setNewEmail('') }}
                      className="px-3 py-1.5 text-xs rounded-lg"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      Annuler
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {users.map(user => {
            const isEditing = editingId === user.id
            const isCurrent = currentUser?.id === user.id
            return (
              <div key={user.id} className="rounded-xl p-3 transition-colors"
                style={{
                  border: isCurrent ? '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)' : '1px solid var(--border-subtle)',
                  background: isCurrent ? 'color-mix(in srgb, var(--accent-primary) 5%, transparent)' : 'transparent',
                }}>
                {isEditing ? (
                  <div className="space-y-2">
                    <input type="text" placeholder="Nom d'affichage" value={editForm.display_name}
                      onChange={e => setEditForm(prev => ({ ...prev, display_name: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                    <input type="password" placeholder="Nouveau mot de passe (vide = inchangé)" value={editForm.password}
                      onChange={e => setEditForm(prev => ({ ...prev, password: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                    <input type="text" placeholder="URL avatar (optionnel)" value={editForm.avatar_url}
                      onChange={e => setEditForm(prev => ({ ...prev, avatar_url: e.target.value }))}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                    <div className="flex gap-2">
                      <button onClick={() => handleUpdate(user.id)} disabled={loading}
                        className="flex-1 px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: 'var(--text-primary)' }}>
                        Sauvegarder
                      </button>
                      <button onClick={() => setEditingId(null)} className="px-3 py-2 rounded-lg text-sm"
                        style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>Annuler</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center font-medium text-sm"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                        {user.avatar_url
                          ? <img src={user.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                          : user.display_name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                          {user.display_name}
                          {currentUser?.id === user.id && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded uppercase font-semibold tracking-wider"
                              style={{ background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', color: 'var(--accent-primary)' }}>
                              actuel
                            </span>
                          )}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>@{user.username}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {currentUser?.id !== user.id && (
                        <button
                          onClick={() => handleImpersonate(user)}
                          className="px-2 py-1 rounded-md text-[10px] font-medium transition-colors hover:opacity-90"
                          style={{
                            background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
                            color: 'var(--accent-primary)',
                            border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
                          }}
                          title="Se connecter en tant que ce user (admin uniquement)"
                        >
                          Tester en tant que
                        </button>
                      )}
                      <button onClick={() => startEditing(user)} className="p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(user.id)} className="p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {showCreate ? (
            <div className="border border-dashed rounded-xl p-4 space-y-2" style={{ borderColor: 'var(--border)' }}>
              <input type="text" placeholder="Nom d'utilisateur" value={createForm.username}
                onChange={e => setCreateForm(prev => ({ ...prev, username: e.target.value }))}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <input type="text" placeholder="Nom d'affichage (optionnel)" value={createForm.display_name}
                onChange={e => setCreateForm(prev => ({ ...prev, display_name: e.target.value }))}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <input type="password" placeholder="Mot de passe (optionnel)" value={createForm.password}
                onChange={e => setCreateForm(prev => ({ ...prev, password: e.target.value }))}
                className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              <div className="flex gap-2">
                <button onClick={handleCreate} disabled={loading}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--scarlet-dark))', color: 'var(--text-primary)' }}>
                  <Plus className="w-3.5 h-3.5" /> Créer
                </button>
                <button onClick={() => setShowCreate(false)} className="px-3 py-2 rounded-lg text-sm"
                  style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>Annuler</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowCreate(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
              <Plus className="w-4 h-4" /> Créer un utilisateur
            </button>
          )}

          {/* Zone de danger — visible uniquement si user authentifié.
              Double confirmation : ouvre un panneau, puis demande de taper
              "supprimer" exact. Refuse si l'user est le dernier admin. */}
          {currentUser && (
            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              {!showSelfDelete ? (
                <button onClick={() => setShowSelfDelete(true)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border text-sm transition-colors"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent-danger, #ef4444) 30%, transparent)',
                    color: 'var(--accent-danger, #ef4444)',
                  }}>
                  <AlertTriangle className="w-4 h-4" /> Supprimer mon compte
                </button>
              ) : (
                <div className="rounded-xl p-4 space-y-3"
                  style={{
                    background: 'color-mix(in srgb, var(--accent-danger, #ef4444) 8%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-danger, #ef4444) 30%, transparent)',
                  }}>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-danger, #ef4444)' }} />
                    <div className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                      <strong style={{ color: 'var(--text-primary)' }}>Action irréversible.</strong> Toutes
                      tes données (conversations, skills, personnalités, sous-agents,
                      channels, intégrations, conscience, KB, workspace…) seront
                      <strong> définitivement supprimées</strong>. Aucune récupération possible.
                    </div>
                  </div>
                  <input type="text" value={selfDeleteConfirm}
                    onChange={e => setSelfDeleteConfirm(e.target.value)}
                    placeholder="Tape « supprimer » pour confirmer"
                    className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <div className="flex gap-2">
                    <button onClick={handleSelfDelete}
                      disabled={selfDeleteConfirm !== 'supprimer' || loading}
                      className="flex-1 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      style={{ background: 'var(--accent-danger, #ef4444)', color: '#fff' }}>
                      {loading ? 'Suppression…' : 'Supprimer définitivement'}
                    </button>
                    <button onClick={() => { setShowSelfDelete(false); setSelfDeleteConfirm('') }}
                      className="px-3 py-2 rounded-lg text-sm transition-colors"
                      style={{ color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>
                      Annuler
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
