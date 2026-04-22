import { useState, useEffect, useRef, useMemo } from 'react'
import type { QuickFile } from '../types'
import { apiFetch, fuzzyMatch, FI, LC } from '../utils'

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND PALETTE
// ═══════════════════════════════════════════════════════════════════════════════

export function CommandPalette({ onClose, onOpenFile }: { onClose: () => void; onOpenFile: (path: string, name?: string) => void }) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<QuickFile[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { apiFetch<{ files: QuickFile[] }>('/files').then(d => d && setFiles(d.files)) }, [])
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelected(0) }, [query])

  const filtered = useMemo(() => {
    if (!query.trim()) return files.slice(0, 20)
    return files.map(f => ({ ...f, ...fuzzyMatch(query, f.path) })).filter(f => f.match).sort((a, b) => b.score - a.score).slice(0, 20)
  }, [query, files])

  const select = (f: QuickFile) => { onOpenFile(f.path, f.name); onClose() }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && filtered[selected]) { select(filtered[selected]) }
    if (e.key === 'Escape') onClose()
  }

  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 520, maxHeight: 420, background: 'var(--bg-secondary)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={handleKey}
            placeholder="Ouvrir un fichier..." style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 14, fontFamily: 'inherit' }} />
          <kbd style={{ fontSize: 9, padding: '1px 6px', background: 'var(--bg-tertiary)', borderRadius: 3, border: '1px solid var(--border)', color: 'var(--text-muted)' }}>Esc</kbd>
        </div>
        <div style={{ maxHeight: 340, overflow: 'auto' }}>
          {filtered.length === 0
            ? <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Aucun fichier trouve</div>
            : filtered.map((f, i) => (
              <div key={f.path} onClick={() => select(f)} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', cursor: 'pointer', fontSize: 12,
                background: i === selected ? 'var(--bg-tertiary)' : 'transparent',
                borderLeft: i === selected ? '3px solid var(--scarlet)' : '3px solid transparent',
              }}>
                <span style={{ fontSize: 13, width: 18, textAlign: 'center', flexShrink: 0 }}>{FI[f.ext] || '\u{1F4C4}'}</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{f.name}</span>
                <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: LC[f.language] || '#6b7280', flexShrink: 0 }} />
              </div>
            ))
          }
        </div>
      </div>
    </div>
  )
}
