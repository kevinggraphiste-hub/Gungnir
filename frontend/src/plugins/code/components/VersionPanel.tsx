import { useState, useEffect, useCallback } from 'react'
import type { VersionInfo } from '../types'
import { apiFetch, fmtSize, MONO, S } from '../utils'
import { IconBtn } from './common'

// ═══════════════════════════════════════════════════════════════════════════════
// VERSION PANEL — File history with rollback
// ═══════════════════════════════════════════════════════════════════════════════

export function VersionPanel({ filePath, onRestore }: { filePath?: string; onRestore: (content: string) => void }) {
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)

  const loadVersions = useCallback(async () => {
    if (!filePath) return
    setLoading(true)
    const data = await apiFetch<{ versions: VersionInfo[] }>(`/version/list?path=${encodeURIComponent(filePath)}`)
    if (data) setVersions(data.versions)
    setLoading(false)
  }, [filePath])

  useEffect(() => { loadVersions() }, [loadVersions])

  const preview = async (vid: string) => {
    if (previewId === vid) { setPreviewId(null); setPreviewContent(null); return }
    if (!filePath) return
    const data = await apiFetch<{ content: string }>(`/version/get?path=${encodeURIComponent(filePath)}&version_id=${encodeURIComponent(vid)}`)
    if (data) { setPreviewId(vid); setPreviewContent(data.content) }
  }

  const restore = async (vid: string) => {
    if (!filePath) return
    setRestoring(vid)
    const data = await apiFetch<{ content: string }>(`/version/get?path=${encodeURIComponent(filePath)}&version_id=${encodeURIComponent(vid)}`)
    if (data) {
      onRestore(data.content)
      setRestoring(null)
    }
  }

  const deleteVersion = async (vid: string) => {
    if (!filePath) return
    await apiFetch(`/version/delete?path=${encodeURIComponent(filePath)}&version_id=${encodeURIComponent(vid)}`, { method: 'DELETE' })
    loadVersions()
  }

  const formatTime = (ts: string) => {
    try { const d = new Date(ts); return `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` }
    catch { return ts }
  }

  if (!filePath) return (
    <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
      Ouvrez un fichier pour voir son historique
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span style={{ ...S.sl, padding: 0, flex: 1 }}>Historique</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{filePath.split('/').pop()}</span>
        <IconBtn onClick={loadVersions} title="Rafraichir"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></IconBtn>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Chargement...</div>
        : versions.length === 0 ? (
          <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.8 }}>
            Aucune version sauvegardee.<br />
            <span style={{ fontSize: 10, opacity: 0.6 }}>Les versions sont creees automatiquement avant chaque sauvegarde et application de code IA.</span>
          </div>
        ) : versions.map(v => (
          <div key={v.version_id} style={{ borderBottom: '1px solid var(--border)' }}>
            <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.label}</div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', display: 'flex', gap: 8, marginTop: 1 }}>
                  <span>{formatTime(v.timestamp)}</span>
                  <span>{v.lines}L</span>
                  <span>{fmtSize(v.size)}</span>
                </div>
              </div>
              <button onClick={() => preview(v.version_id)} title="Apercu"
                style={{ ...S.badge('#3b82f6', previewId === v.version_id), border: 'none', cursor: 'pointer', fontSize: 8, padding: '2px 6px' }}>
                {previewId === v.version_id ? 'Fermer' : 'Voir'}
              </button>
              <button onClick={() => restore(v.version_id)} title="Restaurer cette version"
                style={{ ...S.badge('#22c55e', true), border: 'none', cursor: 'pointer', fontSize: 8, padding: '2px 6px' }}>
                {restoring === v.version_id ? '...' : 'Restaurer'}
              </button>
              <button onClick={() => deleteVersion(v.version_id)} title="Supprimer"
                style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontSize: 9, opacity: 0.4, padding: '0 2px' }}>&times;</button>
            </div>
            {previewId === v.version_id && previewContent && (
              <pre style={{
                margin: '0 12px 6px', padding: 8, borderRadius: 6, fontSize: 10,
                background: '#0c0f14', color: '#c9d1d9', overflow: 'auto', maxHeight: 200,
                fontFamily: MONO, lineHeight: 1.4, border: '1px solid #1e2633',
              }}>{previewContent.substring(0, 3000)}{previewContent.length > 3000 ? '\n... (tronque)' : ''}</pre>
            )}
          </div>
        ))}
      </div>

      {/* Manual snapshot button */}
      <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={async () => {
          if (!filePath) return
          // Need to get current content from the editor — we use the file API
          const fileData = await apiFetch<{ content: string }>(`/file?path=${encodeURIComponent(filePath)}`)
          if (fileData?.content) {
            await apiFetch('/version/save', { method: 'POST', body: JSON.stringify({ path: filePath, content: fileData.content, label: 'Snapshot manuel' }) })
            loadVersions()
          }
        }} style={{
          width: '100%', padding: '5px 0', borderRadius: 5, border: 'none',
          fontSize: 10, fontWeight: 600, cursor: 'pointer',
          background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Creer un snapshot
        </button>
      </div>
    </div>
  )
}
