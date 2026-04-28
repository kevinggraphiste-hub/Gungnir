import { useState, useEffect, useCallback } from 'react'
import type { GitStatus, GitRemote, GitCredentialsState } from '../types'
import { apiFetch, MONO, S } from '../utils'
import { IconBtn } from './common'

// ═══════════════════════════════════════════════════════════════════════════════
// GIT PANEL
// ═══════════════════════════════════════════════════════════════════════════════

const GSM: Record<string, { label: string; color: string }> = {
  'M': { label: 'Modifie', color: '#f59e0b' }, 'A': { label: 'Ajoute', color: '#22c55e' },
  'D': { label: 'Supprime', color: '#dc2626' }, '?': { label: 'Non suivi', color: '#6b7280' },
  '??': { label: 'Non suivi', color: '#6b7280' }, 'R': { label: 'Renomme', color: '#3b82f6' },
  'MM': { label: 'Modifie', color: '#f59e0b' }, 'U': { label: 'Conflit', color: '#f97316' },
}

export function GitPanel({ onBranchChange }: { onBranchChange: (b: string) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [aiGenMsg, setAiGenMsg] = useState(false)
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [showBranches, setShowBranches] = useState(false)
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [showRemote, setShowRemote] = useState(false)
  const [newRemoteUrl, setNewRemoteUrl] = useState('')
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [remoteOutput, setRemoteOutput] = useState<string>('')

  const refresh = useCallback(async () => {
    setLoading(true)
    const data = await apiFetch<GitStatus>('/git/status')
    if (data) { setStatus(data); if (data.branch) onBranchChange(data.branch) }
    const br = await apiFetch<{ branches: string[] }>('/git/branches')
    if (br) setBranches(br.branches)
    const rm = await apiFetch<{ is_repo: boolean; remotes: GitRemote[] }>('/git/remote')
    if (rm?.remotes) setRemotes(rm.remotes)
    setLoading(false)
  }, [onBranchChange])

  useEffect(() => { refresh() }, [refresh])

  const initRepo = async () => { await apiFetch<any>('/git/init', { method: 'POST' }); refresh() }
  const commit = async () => {
    if (!commitMsg.trim()) return
    setCommitting(true)
    const res = await apiFetch<{ ok: boolean; output?: string }>('/git/commit', { method: 'POST', body: JSON.stringify({ message: commitMsg }) })
    if (res && !res.ok && res.output) setRemoteOutput(res.output)
    setCommitMsg(''); setCommitting(false); refresh()
  }
  const toggleDiff = async (path: string) => {
    if (diffFile === path) { setDiffFile(null); setDiffContent(null); return }
    const data = await apiFetch<{ diff: string; staged: string }>(`/git/diff?path=${encodeURIComponent(path)}`)
    setDiffFile(path); setDiffContent(data ? (data.diff || data.staged || 'Pas de diff') : 'Erreur')
  }
  const switchBranch = async (br: string) => {
    await apiFetch<any>('/git/checkout', { method: 'POST', body: JSON.stringify({ branch: br }) })
    setShowBranches(false); refresh()
  }

  const addRemote = async () => {
    const url = newRemoteUrl.trim()
    if (!url) return
    const res = await apiFetch<{ ok: boolean; output?: string }>('/git/remote', { method: 'POST', body: JSON.stringify({ name: 'origin', url }) })
    setRemoteOutput(res?.output || '')
    setNewRemoteUrl('')
    refresh()
  }
  const removeRemote = async (name: string) => {
    if (!confirm(`Supprimer le remote "${name}" ?`)) return
    await apiFetch(`/git/remote/${encodeURIComponent(name)}`, { method: 'DELETE' })
    refresh()
  }
  const doPush = async (setUpstream = false) => {
    setPushing(true); setRemoteOutput('')
    const res = await apiFetch<{ ok: boolean; output?: string; authenticated?: boolean }>('/git/push', {
      method: 'POST', body: JSON.stringify({ remote: 'origin', set_upstream: setUpstream }),
    })
    setRemoteOutput((res?.output || '') + (res?.authenticated === false ? '\n\nAucun PAT stocke — configure ton token dans Parametres > Git.' : ''))
    setPushing(false); refresh()
  }
  const doPull = async () => {
    setPulling(true); setRemoteOutput('')
    const res = await apiFetch<{ ok: boolean; output?: string }>('/git/pull', { method: 'POST', body: JSON.stringify({ remote: 'origin' }) })
    setRemoteOutput(res?.output || '')
    setPulling(false); refresh()
  }

  // Fetch : récupère les refs distantes sans merger. Utile pour voir les
  // commits remote avant de décider de pull.
  const [fetching, setFetching] = useState(false)
  const doFetch = async () => {
    setFetching(true); setRemoteOutput('')
    const res = await apiFetch<{ ok: boolean; output?: string }>('/git/fetch', {
      method: 'POST', body: JSON.stringify({ remote: 'origin' }),
    })
    setRemoteOutput(res?.output || 'Fetch terminé.')
    setFetching(false); refresh()
  }

  // Clone : URL → workspace. Si un dossier du même nom existe déjà côté
  // backend, /git/clone renvoie une erreur que l'user voit dans remoteOutput.
  const [showClone, setShowClone] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')
  const [cloning, setCloning] = useState(false)
  const doClone = async () => {
    const url = cloneUrl.trim()
    if (!url) return
    setCloning(true); setRemoteOutput('')
    const res = await apiFetch<{ ok: boolean; output?: string }>('/git/clone', {
      method: 'POST',
      body: JSON.stringify({ url, dest: cloneDest.trim() || undefined }),
    })
    setRemoteOutput(res?.output || (res?.ok ? 'Clone terminé.' : 'Échec du clone.'))
    setCloning(false)
    if (res?.ok) {
      setCloneUrl(''); setCloneDest(''); setShowClone(false)
      refresh()
    }
  }

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--font-xs)' }}>Chargement...</div>
  if (!status?.is_repo) return (
    <div style={{ padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)', marginBottom: 12 }}>Pas de dépôt Git</div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
        <button onClick={initRepo} style={{ padding: '6px 16px', borderRadius: 6, border: 'none', fontSize: 'var(--font-xs)', fontWeight: 600, background: 'var(--scarlet)', color: '#fff', cursor: 'pointer' }}>Initialiser Git</button>
        <button onClick={() => setShowClone(v => !v)} style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 'var(--font-xs)', fontWeight: 600, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer' }}>Cloner un repo…</button>
      </div>
      {showClone && (
        <div style={{ marginTop: 14, textAlign: 'left', padding: 10, background: 'var(--bg-tertiary)', borderRadius: 6, border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>URL du repo</label>
          <input value={cloneUrl} onChange={e => setCloneUrl(e.target.value)}
            placeholder="https://github.com/user/repo.git"
            style={{ padding: '5px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />
          <label style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', marginTop: 4 }}>Destination (optionnel — nom du dossier)</label>
          <input value={cloneDest} onChange={e => setCloneDest(e.target.value)}
            placeholder="Laisse vide pour utiliser le nom du repo"
            style={{ padding: '5px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />
          <button onClick={doClone} disabled={cloning || !cloneUrl.trim()}
            style={{ marginTop: 4, padding: '6px 0', borderRadius: 4, border: 'none', fontSize: 'var(--font-xs)', fontWeight: 700, background: 'var(--scarlet)', color: '#fff', cursor: cloning ? 'wait' : 'pointer' }}>
            {cloning ? 'Clonage…' : 'Cloner'}
          </button>
          {remoteOutput && (
            <pre style={{ marginTop: 4, padding: 6, fontSize: 'var(--font-2xs)', color: 'var(--text-secondary)', background: 'var(--bg-primary)', borderRadius: 4, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{remoteOutput}</pre>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        <button onClick={() => setShowBranches(!showBranches)} style={{ border: 'none', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 700, fontSize: 'var(--font-xs)' }}>
          {status.branch} {branches.length > 1 ? '▾' : ''}
        </button>
        <div style={{ flex: 1 }} />
        <IconBtn onClick={doFetch} title="git fetch origin (récupère refs sans merger)" disabled={fetching || remotes.length === 0}>
          {fetching
            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/><polyline points="8 12 12 16 16 12"/></svg>}
        </IconBtn>
        <IconBtn onClick={() => doPull()} title="git pull origin" disabled={pulling || remotes.length === 0}>
          {pulling
            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>}
        </IconBtn>
        <IconBtn onClick={() => doPush(remotes.length > 0)} title="git push origin" disabled={pushing || remotes.length === 0}>
          {pushing
            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>}
        </IconBtn>
        <IconBtn onClick={() => setShowRemote(!showRemote)} title="Remote"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/></svg></IconBtn>
        <IconBtn onClick={refresh} title="Rafraichir"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></IconBtn>
      </div>
      {showRemote && (
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)', padding: '6px 12px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Remotes</div>
          {remotes.length === 0 && <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>Aucun remote. Ajoute l'URL https du repo ci-dessous.</div>}
          {remotes.map(r => (
            <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--font-xs)' }}>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.name}</span>
              <span style={{ flex: 1, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 'var(--font-2xs)' }}>{r.url}</span>
              {r.host && <span style={{ ...S.badge('#3b82f6', true), fontSize: 'var(--font-2xs)' }}>{r.host}</span>}
              <button onClick={() => removeRemote(r.name)} title="Supprimer" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#dc2626', opacity: 0.6, fontSize: 'var(--font-xs)' }}>&times;</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 4 }}>
            <input value={newRemoteUrl} onChange={e => setNewRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repo.git"
              style={{ flex: 1, padding: '3px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />
            <button onClick={addRemote} disabled={!newRemoteUrl.trim()} style={{ padding: '3px 8px', fontSize: 'var(--font-2xs)', fontWeight: 700, borderRadius: 4, border: 'none', background: 'var(--scarlet)', color: '#fff', cursor: newRemoteUrl.trim() ? 'pointer' : 'not-allowed' }}>Ajouter</button>
          </div>
          {remoteOutput && (
            <pre style={{ margin: '4px 0 0', padding: 6, borderRadius: 4, fontSize: 'var(--font-2xs)', background: '#0c0f14', color: '#c9d1d9', overflow: 'auto', maxHeight: 100, fontFamily: MONO, lineHeight: 1.35, border: '1px solid #1e2633', whiteSpace: 'pre-wrap' }}>{remoteOutput}</pre>
          )}
        </div>
      )}
      {showBranches && branches.length > 1 && (
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
          {branches.map(br => (
            <div key={br} onClick={() => switchBranch(br)} style={{ padding: '4px 12px', fontSize: 'var(--font-xs)', cursor: 'pointer', color: br === status.branch ? 'var(--scarlet)' : 'var(--text-primary)', fontWeight: br === status.branch ? 700 : 400 }}>
              {br === status.branch ? '• ' : '  '}{br}
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={S.sl}>Changements ({status.files?.length || 0})</div>
        {!status.files?.length ? <div style={{ padding: '10px 12px', fontSize: 'var(--font-xs)', color: 'var(--text-muted)' }}>Aucun changement</div>
        : status.files.map((f, i) => {
          const st = GSM[f.status] || { label: f.status, color: '#6b7280' }
          return (
            <div key={i}>
              <div onClick={() => toggleDiff(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 'var(--font-xs)' }}>
                <span style={{ ...S.badge(st.color, true), fontSize: 'var(--font-2xs)', padding: '0 5px' }}>{st.label}</span>
                <span style={{ flex: 1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
              </div>
              {diffFile === f.path && diffContent && (
                <pre style={{ margin: '0 12px 6px', padding: 6, borderRadius: 4, fontSize: 'var(--font-2xs)', background: '#0c0f14', color: '#c9d1d9', overflow: 'auto', maxHeight: 180, fontFamily: MONO, lineHeight: 1.4, border: '1px solid #1e2633' }}>
                  {diffContent.split('\n').map((line, li) => <div key={li} style={{ color: line.startsWith('+') ? '#22c55e' : line.startsWith('-') ? '#f85149' : line.startsWith('@@') ? '#3b82f6' : '#c9d1d9' }}>{line}</div>)}
                </pre>
              )}
            </div>
          )
        })}
        {status.log && status.log.length > 0 && <>
          <div style={{ ...S.sl, marginTop: 8 }}>Historique</div>
          {status.log.map((l, i) => <div key={i} style={{ padding: '2px 12px', fontSize: 'var(--font-2xs)', color: '#8b949e', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#f59e0b' }}>{l.substring(0, 7)}</span> {l.substring(8)}</div>)}
        </>}
      </div>
      {status.files && status.files.length > 0 && (
        <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input value={commitMsg} onChange={e => setCommitMsg(e.target.value)} onKeyDown={e => e.key === 'Enter' && commit()} placeholder="Message de commit..." style={{ flex: 1, padding: '5px 8px', fontSize: 'var(--font-xs)', borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
            <button onClick={async () => {
              setAiGenMsg(true)
              const diffData = await apiFetch<{ diff: string; staged: string }>('/git/diff')
              const fullDiff = (diffData?.diff || '') + '\n' + (diffData?.staged || '')
              if (!fullDiff.trim()) { setAiGenMsg(false); return }
              const res = await apiFetch<{ ok: boolean; message?: string }>('/git/ai-commit-message', {
                method: 'POST', body: JSON.stringify({ diff: fullDiff }),
              })
              if (res?.ok && res.message) setCommitMsg(res.message)
              setAiGenMsg(false)
            }} disabled={aiGenMsg} title="Generer message IA depuis le diff"
              style={{ padding: '4px 8px', borderRadius: 5, border: 'none', fontSize: 'var(--font-2xs)', fontWeight: 700, cursor: 'pointer', background: '#8b5cf620', color: '#8b5cf6', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}>
              {aiGenMsg ? <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#8b5cf6', animation: 'pulse 1s ease-in-out infinite' }} /> : '✨'} IA
            </button>
          </div>
          <button onClick={commit} disabled={committing || !commitMsg.trim()} style={{ width: '100%', padding: '5px 0', borderRadius: 5, border: 'none', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: commitMsg.trim() ? 'pointer' : 'not-allowed', background: commitMsg.trim() ? 'var(--scarlet)' : 'var(--bg-tertiary)', color: commitMsg.trim() ? '#fff' : 'var(--text-muted)' }}>
            {committing ? 'Commit...' : 'Commit'}
          </button>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT CREDENTIALS PANEL (used by SettingsPanel)
// ═══════════════════════════════════════════════════════════════════════════════

const GIT_HOST_LABELS: Record<string, string> = {
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'bitbucket.org': 'Bitbucket',
}

export function GitCredentialsPanel() {
  const [state, setState] = useState<GitCredentialsState>({ hosts: [] })
  const [selectedHost, setSelectedHost] = useState('github.com')
  const [tokenInput, setTokenInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const d = await apiFetch<GitCredentialsState>('/git/credentials')
    if (d) {
      setState(d)
      setNameInput(d.user_name || '')
      setEmailInput(d.user_email || '')
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const saveToken = async () => {
    if (!tokenInput.trim()) return
    setBusy(true); setMsg(null)
    const res = await apiFetch<{ ok: boolean }>('/git/credentials', {
      method: 'POST', body: JSON.stringify({ host: selectedHost, token: tokenInput.trim() }),
    })
    setBusy(false); setTokenInput('')
    setMsg(res?.ok ? `PAT ${selectedHost} enregistre` : 'Erreur')
    reload()
    setTimeout(() => setMsg(null), 2500)
  }

  const removeToken = async (host: string) => {
    if (!confirm(`Supprimer le PAT pour ${host} ?`)) return
    await apiFetch(`/git/credentials/${encodeURIComponent(host)}`, { method: 'DELETE' })
    reload()
  }

  const saveIdentity = async () => {
    if (!nameInput.trim() || !emailInput.trim()) return
    setBusy(true); setMsg(null)
    const res = await apiFetch<{ ok: boolean }>('/git/config/identity', {
      method: 'POST', body: JSON.stringify({ user_name: nameInput.trim(), user_email: emailInput.trim() }),
    })
    setBusy(false)
    setMsg(res?.ok ? 'Identite enregistree' : 'Erreur')
    reload()
    setTimeout(() => setMsg(null), 2500)
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div style={{ ...S.sl, paddingTop: 10 }}>Git — Identite & PAT</div>
      <div style={{ padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>Nom (git commit author)</label>
        <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Kevin Graphiste"
          style={{ padding: '4px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
        <label style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', marginTop: 4 }}>Email</label>
        <input value={emailInput} onChange={e => setEmailInput(e.target.value)} placeholder="kevin@exemple.com"
          style={{ padding: '4px 8px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
        <button onClick={saveIdentity} disabled={busy || !nameInput.trim() || !emailInput.trim()}
          style={{ marginTop: 4, padding: '5px 0', borderRadius: 4, border: 'none', fontSize: 'var(--font-xs)', fontWeight: 700, cursor: (busy || !nameInput.trim() || !emailInput.trim()) ? 'not-allowed' : 'pointer', background: 'var(--scarlet)', color: '#fff', opacity: (busy || !nameInput.trim() || !emailInput.trim()) ? 0.6 : 1 }}>
          Enregistrer identite
        </button>
      </div>

      <div style={{ padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)' }}>Tokens d'acces (chiffres)</label>
        {state.hosts.map(h => (
          <div key={h.host} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-xs)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: h.configured ? '#22c55e' : '#6b7280' }} />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: 70 }}>{GIT_HOST_LABELS[h.host] || h.host}</span>
            <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 'var(--font-2xs)' }}>{h.configured ? 'Configure' : 'Aucun token'}</span>
            {h.configured && <button onClick={() => removeToken(h.host)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#dc2626', opacity: 0.6, fontSize: 'var(--font-xs)' }}>&times;</button>}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <select value={selectedHost} onChange={e => setSelectedHost(e.target.value)}
            style={{ padding: '3px 6px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }}>
            {Object.entries(GIT_HOST_LABELS).map(([h, label]) => <option key={h} value={h}>{label}</option>)}
          </select>
          <input type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder={`PAT ${selectedHost}`}
            autoComplete="new-password"
            style={{ flex: 1, padding: '3px 6px', fontSize: 'var(--font-xs)', borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />
          <button onClick={saveToken} disabled={busy || !tokenInput.trim()}
            style={{ padding: '3px 8px', fontSize: 'var(--font-2xs)', fontWeight: 700, borderRadius: 4, border: 'none', background: 'var(--scarlet)', color: '#fff', cursor: (busy || !tokenInput.trim()) ? 'not-allowed' : 'pointer', opacity: (busy || !tokenInput.trim()) ? 0.6 : 1 }}>Ajouter</button>
        </div>
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-muted)', opacity: 0.8 }}>Scopes GitHub minimum : repo. Le token est chiffre en base et injecte uniquement dans l'URL au moment du push/pull.</span>
        {msg && <span style={{ fontSize: 'var(--font-xs)', color: msg.includes('Erreur') ? '#f87171' : '#22c55e' }}>{msg}</span>}
      </div>
    </div>
  )
}
