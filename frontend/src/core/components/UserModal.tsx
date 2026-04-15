import { useState, useEffect } from 'react'
import { X, User, Plus, Trash2, Pencil, Check } from 'lucide-react'
import { api, clearAuthToken } from '../services/api'

interface UserData {
  id: number
  username: string
  display_name: string
  avatar_url: string
  is_active: boolean
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

  useEffect(() => { if (isOpen) loadUsers() }, [isOpen])

  const loadUsers = async () => {
    try { const data = await api.getUsers(); setUsers(data) } catch { /* ignore */ }
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

  const startEditing = (user: UserData) => {
    setEditingId(user.id)
    setEditForm({ display_name: user.display_name, password: '', avatar_url: user.avatar_url || '' })
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
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
        </div>
      </div>
    </div>
  )
}
