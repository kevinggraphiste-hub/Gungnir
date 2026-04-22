import { useState, useEffect } from 'react'
import type { OpenTab } from '../types'
import { LC, MONO, apiFetch, fmtSize } from '../utils'

// ═══════════════════════════════════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

export function HBtn({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return <button onClick={onClick} title={title} style={{ padding: '4px 7px', cursor: 'pointer', border: 'none', borderRadius: 4, background: active ? 'var(--scarlet)' : 'transparent', color: active ? '#fff' : 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.12s' }}>{children}</button>
}

export function IconBtn({ onClick, children, title, disabled }: { onClick: () => void; children: React.ReactNode; title?: string; disabled?: boolean }) {
  return <button onClick={onClick} title={title} disabled={disabled} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: disabled ? 'not-allowed' : 'pointer', padding: '2px 3px', display: 'flex', opacity: disabled ? 0.4 : 1 }}>{children}</button>
}

export function TabBtn({ tab, active, onClick, onClose }: { tab: OpenTab; active: boolean; onClick: () => void; onClose: () => void }) {
  const lc = LC[tab.language] || '#6b7280'
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', cursor: 'pointer', flexShrink: 0, fontSize: 11, background: active ? 'var(--bg-primary)' : 'transparent', borderBottom: active ? '2px solid var(--scarlet)' : '2px solid transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)', transition: 'all 0.1s' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: tab.modified ? '#f59e0b' : lc }} />
      <span style={{ fontWeight: active ? 600 : 400, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tab.language === '__image__' ? `\u{1F5BC}️ ${tab.name}` : tab.name}{tab.modified ? ' *' : ''}
      </span>
      <button onClick={e => { e.stopPropagation(); onClose() }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 2px', opacity: 0.4, lineHeight: 1, fontSize: 10 }}>&times;</button>
    </div>
  )
}

export function Breadcrumbs({ path }: { path: string }) {
  const parts = path.split('/')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '3px 14px', flexShrink: 0, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', fontSize: 10, overflow: 'auto' }}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {i > 0 && <span style={{ color: 'var(--text-muted)', opacity: 0.3 }}>/</span>}
          <span style={{ color: i === parts.length - 1 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: i === parts.length - 1 ? 600 : 400 }}>{p}</span>
        </span>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════════════════════════════════════════════

export function StatusBar({ file, gitBranch, tabCount, modifiedCount }: { file: OpenTab | null; gitBranch: string; tabCount: number; modifiedCount: number }) {
  const lineCount = file ? file.content.split('\n').length : 0
  const wordCount = file ? file.content.split(/\s+/).filter(Boolean).length : 0
  const langColor = LC[file?.language || ''] || '#6b7280'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '3px 16px', flexShrink: 0, background: '#1a1d24', borderTop: '1px solid var(--border)', fontSize: 10, color: '#8b949e', fontFamily: MONO }}>
      {gitBranch && <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        {gitBranch}
      </span>}
      <div style={{ width: 1, height: 10, background: '#2d333b' }} />
      {file && file.language !== '__image__' && <>
        <span>Ln {file.cursorLine}, Col {file.cursorCol}</span>
        <span>{lineCount} lignes</span>
        <span>{wordCount} mots</span>
      </>}
      <div style={{ flex: 1 }} />
      {modifiedCount > 0 && <span style={{ color: '#f59e0b' }}>{modifiedCount} modifie{modifiedCount > 1 ? 's' : ''}</span>}
      <span>{tabCount} onglet{tabCount > 1 ? 's' : ''}</span>
      {file && file.language !== '__image__' && <span style={{ color: langColor, fontWeight: 700 }}>{file.language}</span>}
      <span>UTF-8</span>
      <span style={{ color: 'var(--scarlet)', fontWeight: 700 }}>SpearCode</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// WELCOME SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

export function WelcomeScreen({ onOpenPalette }: { onOpenPalette: () => void }) {
  const [stats, setStats] = useState<any>(null)
  const [analysis, setAnalysis] = useState<any>(null)
  useEffect(() => { apiFetch<any>('/stats').then(setStats); apiFetch<any>('/analyze').then(setAnalysis) }, [])

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', maxWidth: 480, padding: 40 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2" style={{ flexShrink: 0 }}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          <span style={{ fontSize: 32, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: -0.5, whiteSpace: 'nowrap' }}>SpearCode</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 24 }}>IDE nouvelle generation avec IA, Git, diff viewer et command palette</div>

        <button onClick={onOpenPalette} style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 20px', borderRadius: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)',
          cursor: 'pointer', fontSize: 12, marginBottom: 24,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Ouvrir un fichier...
          <kbd style={{ padding: '1px 6px', background: 'var(--bg-tertiary)', borderRadius: 3, fontSize: 10, border: '1px solid var(--border)' }}>Ctrl+K</kbd>
        </button>

        {stats && (
          <div style={{ display: 'flex', gap: 1, justifyContent: 'center', marginBottom: 20, background: 'var(--bg-secondary)', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <WStat label="Fichiers" value={stats.total_files} />
            <WStat label="Dossiers" value={stats.total_dirs} />
            <WStat label="Taille" value={fmtSize(stats.total_size)} />
          </div>
        )}

        {analysis?.language && analysis.language !== 'unknown' && (
          <div style={{ display: 'inline-flex', gap: 8, padding: '6px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Langage:</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: LC[analysis.language] || 'var(--text-primary)' }}>{analysis.language}</span>
            {analysis.framework && <><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Framework:</span><span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-primary)' }}>{analysis.framework}</span></>}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', fontSize: 9, color: 'var(--text-muted)', marginTop: 8, flexWrap: 'wrap' }}>
          {[['Ctrl+K', 'Palette'], ['Ctrl+S', 'Sauver'], ['Ctrl+H', 'Chercher'], ['Ctrl+D', 'Diff'], ['Ctrl+L', 'IA Chat'], ['Ctrl+Shift+A', 'Agent'], ['Ctrl+Shift+T', 'Terminal'], ['Ctrl+Shift+S', 'Snippets'], ['Ctrl+Shift+P', 'Preview']].map(([k, d]) => (
            <span key={k}><kbd style={{ padding: '0 4px', background: 'var(--bg-tertiary)', borderRadius: 2, fontSize: 8, border: '1px solid var(--border)' }}>{k}</kbd> {d}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

function WStat({ label, value }: { label: string; value: string | number }) {
  return <div style={{ flex: 1, padding: '10px 8px', textAlign: 'center' }}><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>{value}</div><div style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div></div>
}
