import { useState, useEffect, useCallback, useRef } from 'react'
import type { TreeEntry, SearchResult } from '../types'
import { API, apiFetch, fmtSize, FI, LC, MONO, S } from '../utils'
import { IconBtn } from './common'

// ═══════════════════════════════════════════════════════════════════════════════
// FILE EXPLORER
// ═══════════════════════════════════════════════════════════════════════════════

export function FileExplorer({ onOpenFile }: { onOpenFile: (path: string, name?: string) => void }) {
  const [tree, setTree] = useState<TreeEntry[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [pathStack, setPathStack] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [newName, setNewName] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const loadTree = useCallback(async (path = '') => {
    setLoading(true)
    const data = await apiFetch<{ entries: TreeEntry[] }>(`/tree?path=${encodeURIComponent(path)}`)
    if (data) setTree(data.entries)
    setLoading(false)
  }, [])

  useEffect(() => { loadTree('') }, [loadTree])

  const navIn = (p: string) => { setPathStack(s => [...s, currentPath]); setCurrentPath(p); loadTree(p) }
  const navBack = () => { const p = pathStack[pathStack.length - 1] ?? ''; setPathStack(s => s.slice(0, -1)); setCurrentPath(p); loadTree(p) }

  // Trouve un nom disponible dans le dossier courant en ajoutant un suffixe
  // `-2`, `-3`, etc. si collision (insensible à la casse). Préserve l'extension
  // pour les fichiers (ex: `test.py` → `test-2.py`). Évite d'écraser
  // silencieusement un dossier/fichier existant.
  const findAvailableName = (base: string, existing: TreeEntry[]): string => {
    const names = new Set(existing.map(e => e.name.toLowerCase()))
    if (!names.has(base.toLowerCase())) return base
    const dot = base.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
    for (let i = 2; i < 100; i++) {
      const candidate = `${stem}-${i}${ext}`
      if (!names.has(candidate.toLowerCase())) return candidate
    }
    return `${stem}-${Date.now()}${ext}`
  }

  const handleCreate = async () => {
    if (!newName.trim()) return
    const finalName = findAvailableName(newName.trim(), tree)
    const full = currentPath ? `${currentPath}/${finalName}` : finalName
    if (creating === 'folder') await apiFetch('/folder', { method: 'POST', body: JSON.stringify({ path: full }) })
    else await apiFetch('/file', { method: 'PUT', body: JSON.stringify({ path: full, content: '' }) })
    setCreating(null); setNewName(''); loadTree(currentPath)
  }

  // Nouveau projet : toujours à la racine du workspace (pas dans le dossier
  // courant). Le nom demandé via prompt — si collision, auto-rename avec
  // suffixe. Après création, on y navigue pour que l'user démarre directement
  // dans son nouveau dossier.
  const handleNewProject = async () => {
    const defaultName = `projet-${new Date().toISOString().slice(0, 10)}`
    const raw = window.prompt('Nom du projet', defaultName)
    if (!raw || !raw.trim()) return
    // On lit la racine workspace (indépendamment du currentPath) pour résoudre
    // la collision au bon niveau.
    const rootData = await apiFetch<{ entries: TreeEntry[] }>(`/tree?path=`)
    const rootEntries = rootData?.entries || []
    const finalName = findAvailableName(raw.trim(), rootEntries)
    await apiFetch('/folder', { method: 'POST', body: JSON.stringify({ path: finalName }) })
    // Navigate dedans
    setPathStack([])
    setCurrentPath(finalName)
    loadTree(finalName)
  }

  const handleDelete = async (path: string, name: string) => {
    if (!confirm(`Supprimer ${name} ?`)) return
    await apiFetch(`/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    loadTree(currentPath)
  }

  // Drag & drop : source (sourcePath) déplacée vers destFolderPath
  // ('' = racine workspace). Calcule le new_path et appelle /rename. Si le
  // backend refuse (collision 409, etc.), on alerte l'user et on rafraîchit
  // pour ne pas laisser un état stale visuel.
  const handleMove = useCallback(async (sourcePath: string, destFolderPath: string) => {
    if (!sourcePath) return
    // Anti-no-op : déjà au bon endroit
    const sourceParent = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : ''
    if (sourceParent === destFolderPath) return
    // Anti-récursion : déplacer un dossier dans lui-même ou dans ses descendants
    if (destFolderPath === sourcePath || destFolderPath.startsWith(sourcePath + '/')) {
      alert("Impossible de déplacer un dossier dans lui-même.")
      return
    }
    const sourceName = sourcePath.includes('/') ? sourcePath.slice(sourcePath.lastIndexOf('/') + 1) : sourcePath
    const newPath = destFolderPath ? `${destFolderPath}/${sourceName}` : sourceName
    const r = await apiFetch<{ ok: boolean; error?: string }>('/rename', {
      method: 'POST',
      body: JSON.stringify({ old_path: sourcePath, new_path: newPath }),
    })
    if (!r?.ok) {
      alert(`Déplacement impossible${r?.error ? ` : ${r.error}` : ' (le nom existe peut-être déjà à destination)'}`)
    }
    loadTree(currentPath)
  }, [currentPath, loadTree])

  // État du back button quand on glisse un item dessus pour le remonter d'un cran.
  const [backHover, setBackHover] = useState(false)
  const parentOfCurrent = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/'))
    : ''

  const handleUpload = async (filesList: FileList | null) => {
    if (!filesList || filesList.length === 0) return
    setUploading(true)
    try {
      const form = new FormData()
      for (const f of Array.from(filesList)) form.append('files', f, f.name)
      if (currentPath) form.append('dest', currentPath)
      // Don't set Content-Type — the browser fills multipart boundary itself.
      const res = await fetch(`${API}/upload`, { method: 'POST', body: form })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        alert(`Import echec (${res.status}) ${msg.slice(0, 200)}`)
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
      loadTree(currentPath)
    }
  }

  const handleExport = async () => {
    const path = currentPath || ''
    const target = path || 'workspace'
    const label = path ? path.split('/').pop() || path : 'workspace'
    try {
      const res = await fetch(`${API}/download?path=${encodeURIComponent(target === 'workspace' ? '' : path)}`)
      if (!res.ok) {
        alert(`Export echec (${res.status})`)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // Backend sets Content-Disposition; browser honors it, but fallback is safer.
      a.download = `${label}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert(`Export erreur: ${String(e)}`)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
        onChange={e => handleUpload(e.target.files)} />
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {currentPath && (
          <span
            onDragOver={e => {
              if (!e.dataTransfer.types.includes('application/x-gungnir-path')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (!backHover) setBackHover(true)
            }}
            onDragLeave={() => setBackHover(false)}
            onDrop={e => {
              e.preventDefault()
              setBackHover(false)
              const src = e.dataTransfer.getData('application/x-gungnir-path')
              if (src) handleMove(src, parentOfCurrent)
            }}
            style={{ display: 'inline-flex', borderRadius: 4, background: backHover ? 'rgba(220,38,38,0.22)' : 'transparent', boxShadow: backHover ? 'inset 0 0 0 1px var(--scarlet)' : undefined }}
          >
            <IconBtn onClick={navBack}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg></IconBtn>
          </span>
        )}
        <span style={{ ...S.sl, padding: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPath || 'Workspace'}</span>
        <IconBtn onClick={handleNewProject} title="Nouveau projet (sous-dossier à la racine du workspace)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
            <path d="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-9l-2-3H4a1 1 0 0 0-1 1z"/>
            <circle cx="16" cy="14" r="3" fill="var(--scarlet)" stroke="none"/>
            <line x1="16" y1="12.5" x2="16" y2="15.5" stroke="white" strokeWidth="1.5"/>
            <line x1="14.5" y1="14" x2="17.5" y2="14" stroke="white" strokeWidth="1.5"/>
          </svg>
        </IconBtn>
        <IconBtn onClick={() => setCreating(creating ? null : 'file')} title="Nouveau fichier"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg></IconBtn>
        <IconBtn onClick={() => setCreating(creating ? null : 'folder')} title="Nouveau dossier"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg></IconBtn>
        <IconBtn onClick={() => !uploading && fileInputRef.current?.click()} title={uploading ? 'Import en cours...' : 'Importer depuis le PC'}>
          {uploading
            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>}
        </IconBtn>
        <IconBtn onClick={handleExport} title={`Exporter ${currentPath || 'workspace'} (.zip)`}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></IconBtn>
        <IconBtn onClick={() => loadTree(currentPath)} title="Rafraichir"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></IconBtn>
      </div>
      {creating && (
        <div style={{ padding: '5px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 4 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(null); setNewName('') } }}
            placeholder={creating === 'folder' ? 'Nom du dossier...' : 'Nom du fichier...'} autoFocus
            style={{ flex: 1, padding: '3px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
          <button onClick={handleCreate} style={{ border: 'none', background: 'var(--scarlet)', color: '#fff', borderRadius: 4, padding: '3px 8px', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>OK</button>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '2px 0' }}>
        {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Chargement...</div>
        : tree.length === 0 ? <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>Dossier vide. Placez un projet dans <code style={{ fontSize: 10, background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: 3 }}>data/workspace/</code></div>
        : tree.map(e => <FileRow key={e.path} entry={e}
            onClick={() => e.is_dir ? navIn(e.path) : onOpenFile(e.path, e.name)}
            onDelete={() => handleDelete(e.path, e.name)}
            onMove={handleMove}
            onRename={async (newName) => {
              const parent = currentPath
              const newPath = parent ? `${parent}/${newName}` : newName
              if (newPath === e.path) return
              const r = await apiFetch<{ ok: boolean; error?: string }>('/rename', {
                method: 'POST',
                body: JSON.stringify({ old_path: e.path, new_path: newPath }),
              })
              if (!r?.ok) {
                alert(`Renommage impossible${r?.error ? ` : ${r.error}` : ''}`)
                return
              }
              loadTree(currentPath)
            }}
          />)}
      </div>
    </div>
  )
}

export function FileRow({ entry, onClick, onDelete, onRename, onMove }: {
  entry: TreeEntry
  onClick: () => void
  onDelete: () => void
  onRename?: (newName: string) => void | Promise<void>
  onMove?: (sourcePath: string, destFolderPath: string) => void | Promise<void>
}) {
  const [h, setH] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(entry.name)
  const [dropOver, setDropOver] = useState(false)
  const icon = entry.is_dir ? null : FI[entry.ext || '']

  const commitRename = async () => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === entry.name || !onRename) { setDraft(entry.name); return }
    await onRename(name)
    setDraft(name)
  }

  if (renaming) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 12px', background: 'var(--bg-tertiary)' }}>
        {entry.is_dir
          ? <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--text-muted)" stroke="none" opacity={0.4}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          : <span style={{ width: 13, textAlign: 'center', fontSize: 10, flexShrink: 0 }}>{icon || '\u{1F4C4}'}</span>}
        <input
          autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') { setRenaming(false); setDraft(entry.name) }
          }}
          onBlur={commitRename}
          style={{
            flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--scarlet)',
            borderRadius: 3, padding: '1px 5px', fontSize: 11.5, color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
      </div>
    )
  }

  return (
    <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      draggable={true}
      onDragStart={e => {
        e.dataTransfer.setData('application/x-gungnir-path', entry.path)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDropOver(false)}
      onDragOver={entry.is_dir && onMove ? e => {
        const src = e.dataTransfer.types.includes('application/x-gungnir-path')
        if (!src) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dropOver) setDropOver(true)
      } : undefined}
      onDragLeave={entry.is_dir && onMove ? () => setDropOver(false) : undefined}
      onDrop={entry.is_dir && onMove ? e => {
        e.preventDefault()
        e.stopPropagation()
        setDropOver(false)
        const src = e.dataTransfer.getData('application/x-gungnir-path')
        if (src && src !== entry.path) onMove(src, entry.path)
      } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 12px', cursor: 'pointer', fontSize: 11.5, background: dropOver ? 'rgba(220,38,38,0.18)' : (h ? 'var(--bg-tertiary)' : 'transparent'), boxShadow: dropOver ? 'inset 0 0 0 1px var(--scarlet)' : undefined, transition: 'background 0.06s' }}>
      {entry.is_dir
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--text-muted)" stroke="none" opacity={0.4}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        : <span style={{ width: 13, textAlign: 'center', fontSize: 10, flexShrink: 0 }}>{icon || '\u{1F4C4}'}</span>}
      <span style={{ flex: 1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
      {!entry.is_dir && entry.language && <span style={{ width: 4, height: 4, borderRadius: '50%', background: LC[entry.language] || '#6b7280', opacity: 0.5 }} />}
      {entry.is_dir && entry.children_count !== undefined && <span style={{ ...S.badge('#6b7280'), fontSize: 7, padding: '0 4px' }}>{entry.children_count}</span>}
      {!entry.is_dir && <span style={{ fontSize: 8, color: 'var(--text-muted)', opacity: 0.4 }}>{fmtSize(entry.size || 0)}</span>}
      {h && onRename && (
        <button onClick={e => { e.stopPropagation(); setDraft(entry.name); setRenaming(true) }}
          title="Renommer"
          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 0, opacity: 0.7, fontSize: 10 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
      )}
      {h && <button onClick={e => { e.stopPropagation(); onDelete() }}
        title="Supprimer"
        style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', padding: 0, opacity: 0.5, fontSize: 9 }}>&times;</button>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH PANEL
// ═══════════════════════════════════════════════════════════════════════════════

export function SearchPanel({ onOpenFile }: { onOpenFile: (path: string, name?: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)

  const doSearch = async () => {
    if (!query.trim()) return
    setLoading(true)
    const data = await apiFetch<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(query)}`)
    if (data) setResults(data.results)
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)' }}>
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && doSearch()}
          placeholder="Rechercher..." style={{ width: '100%', padding: '5px 10px', fontSize: 11, borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Recherche...</div>
        : results.length === 0 ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>{query ? 'Aucun resultat' : 'Tapez pour chercher'}</div>
        : results.map((r, i) => (
          <div key={i} onClick={() => onOpenFile(r.path, r.name)} style={{ padding: '6px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>{r.name}</div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{r.path}</div>
            {r.snippet && <div style={{ fontSize: 10, fontFamily: MONO, marginTop: 2, padding: '2px 6px', background: 'var(--bg-tertiary)', borderRadius: 3, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>L{r.line}: {r.snippet}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
