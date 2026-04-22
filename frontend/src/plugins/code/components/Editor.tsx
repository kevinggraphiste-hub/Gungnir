import { useState, useEffect, useRef } from 'react'
import type { OpenTab } from '../types'
import { LC, S } from '../utils'
import { CodeMirrorEditor } from './CodeMirrorEditor'

// ═══════════════════════════════════════════════════════════════════════════════
// FIND & REPLACE
// ═══════════════════════════════════════════════════════════════════════════════

export function FindReplace({ content, onChange }: { content: string; onChange: (c: string) => void }) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [matchCount, setMatchCount] = useState(0)

  useEffect(() => {
    if (!find) { setMatchCount(0); return }
    try {
      const flags = caseSensitive ? 'g' : 'gi'
      const regex = useRegex ? new RegExp(find, flags) : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      setMatchCount((content.match(regex) || []).length)
    } catch { setMatchCount(0) }
  }, [find, content, useRegex, caseSensitive])

  const doReplace = (all: boolean) => {
    if (!find) return
    try {
      const flags = caseSensitive ? (all ? 'g' : '') : (all ? 'gi' : 'i')
      const regex = useRegex ? new RegExp(find, flags) : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      onChange(content.replace(regex, replace))
    } catch { /* invalid regex */ }
  }

  const inp = { padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }

  return (
    <div style={{ padding: '6px 14px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
      <input value={find} onChange={e => setFind(e.target.value)} placeholder="Chercher..." style={{ ...inp, width: 160 }} />
      <input value={replace} onChange={e => setReplace(e.target.value)} placeholder="Remplacer..." style={{ ...inp, width: 140 }} />
      <button onClick={() => setCaseSensitive(c => !c)} style={{ ...S.badge(caseSensitive ? 'var(--scarlet)' : '#6b7280', caseSensitive), border: 'none' }}>Aa</button>
      <button onClick={() => setUseRegex(r => !r)} style={{ ...S.badge(useRegex ? 'var(--scarlet)' : '#6b7280', useRegex), border: 'none' }}>.*</button>
      <span style={{ fontSize: 10, color: matchCount > 0 ? '#22c55e' : 'var(--text-muted)', fontWeight: 600 }}>{matchCount} resultat{matchCount !== 1 ? 's' : ''}</span>
      <div style={{ flex: 1 }} />
      <button onClick={() => doReplace(false)} disabled={!find || matchCount === 0} style={{ ...S.badge('#3b82f6', true), border: 'none', opacity: find ? 1 : 0.4 }}>Remplacer</button>
      <button onClick={() => doReplace(true)} disabled={!find || matchCount === 0} style={{ ...S.badge('#f97316', true), border: 'none', opacity: find ? 1 : 0.4 }}>Tout</button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MINIMAP
// ═══════════════════════════════════════════════════════════════════════════════

export function Minimap({ content, language }: { content: string; language: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lines = content.split('\n')
  const lc = LC[language] || '#6b7280'

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const w = 60
    cv.width = w
    cv.height = Math.max(200, lines.length * 2)
    ctx.clearRect(0, 0, w, cv.height)

    lines.forEach((line, i) => {
      const trimmed = line.replace(/\s/g, '')
      if (!trimmed) return
      const indent = line.length - line.trimStart().length
      const barW = Math.min(trimmed.length * 0.5, w - indent * 0.5 - 2)
      const isKeyword = line.includes('function') || line.includes('class') || line.includes('def ') || line.includes('const ') || line.includes('import ')
      const isComment = line.trimStart().startsWith('//') || line.trimStart().startsWith('#') || line.trimStart().startsWith('/*')
      ctx.fillStyle = isKeyword ? lc + '90' : isComment ? '#6b728050' : '#c9d1d930'
      ctx.fillRect(indent * 0.5 + 2, i * 2, Math.max(barW, 2), 1.5)
    })
  }, [content, language])

  return (
    <div style={{ width: 64, flexShrink: 0, overflow: 'hidden', borderLeft: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
      <canvas ref={canvasRef} style={{ width: 60, display: 'block', opacity: 0.8 }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE EDITOR
// ═══════════════════════════════════════════════════════════════════════════════

export function CodeEditor({ file, onChange, onSave, onRun, onCursorChange }: {
  file: OpenTab; onChange: (c: string) => void; onSave: () => void; onRun?: () => void; onCursorChange?: (line: number, col: number) => void
}) {
  const lines = file.content.split('\n')
  const langColor = LC[file.language] || '#6b7280'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexShrink: 0, fontSize: 10 }}>
        <span style={{ ...S.badge(langColor, true), fontSize: 8 }}>{file.language}</span>
        <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>{file.path}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>{lines.length} lignes</span>
        {file.modified && <span style={{ fontSize: 8, fontWeight: 700, color: '#f59e0b' }}>MODIFIE</span>}
        {onRun && <button onClick={onRun} style={{ ...S.badge('#22c55e', true), border: 'none', cursor: 'pointer', fontSize: 8 }}>&#9654; Run</button>}
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <CodeMirrorEditor
          value={file.content}
          language={file.language}
          onChange={onChange}
          onSave={onSave}
          onCursorChange={onCursorChange}
        />
      </div>
    </div>
  )
}
