// ── Outline Panel ────────────────────────────────────────────────────────────
// Liste les symboles (classes, fonctions, méthodes, interfaces, constantes)
// du fichier actif — arbre cliquable pour naviguer rapidement dans un gros
// fichier sans scroller.
//
// Parsing par regex côté frontend : moins précis qu'un LSP/AST, mais suffisant
// pour les 90% de cas courants (détection de déclarations top-level). Zéro
// round-trip réseau, réactif à chaque changement du fichier.

import { useMemo, useState } from 'react'
import type { OpenTab } from '../types'

type SymbolKind = 'class' | 'function' | 'method' | 'interface' | 'type' | 'const' | 'var' | 'enum'

interface SymbolEntry {
  kind: SymbolKind
  name: string
  line: number  // 1-based
  indent: number
}

const KIND_ICON: Record<SymbolKind, string> = {
  class: '🟣',
  function: '🔹',
  method: '🔸',
  interface: '🟢',
  type: '🟡',
  const: '🟤',
  var: '⚪',
  enum: '🟠',
}

const KIND_COLOR: Record<SymbolKind, string> = {
  class: '#a855f7',
  function: '#3b82f6',
  method: '#06b6d4',
  interface: '#22c55e',
  type: '#eab308',
  const: '#f97316',
  var: '#6b7280',
  enum: '#ec4899',
}

function parsePython(content: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    // class Foo:  |  class Foo(Base):
    let m = line.match(/^class\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'class', name: m[1], line: i + 1, indent }); continue }
    // def / async def
    m = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/)
    if (m) {
      out.push({ kind: indent > 0 ? 'method' : 'function', name: m[1], line: i + 1, indent })
      continue
    }
  }
  return out
}

function parseJsTs(content: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    let m
    // export class Foo { … }
    m = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'class', name: m[1], line: i + 1, indent }); continue }
    // export interface Foo
    m = line.match(/^(?:export\s+)?interface\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'interface', name: m[1], line: i + 1, indent }); continue }
    // export type Foo = …
    m = line.match(/^(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=/)
    if (m) { out.push({ kind: 'type', name: m[1], line: i + 1, indent }); continue }
    // export enum Foo
    m = line.match(/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'enum', name: m[1], line: i + 1, indent }); continue }
    // export function foo() / async function foo()
    m = line.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'function', name: m[1], line: i + 1, indent }); continue }
    // const foo = () => … / const foo = function(…) … / const foo = async …
    m = line.match(/^(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s+)?\(/)
    if (m) { out.push({ kind: 'function', name: m[1], line: i + 1, indent }); continue }
    m = line.match(/^(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s+)?(?:function|<)/)
    if (m) { out.push({ kind: 'function', name: m[1], line: i + 1, indent }); continue }
    // Methods dans une classe (indent > 0) : foo() { … } / async foo() / foo = …
    if (indent > 0) {
      m = line.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*[\w<>[\],\s|&]+\s*)?\{/)
      if (m && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) {
        out.push({ kind: 'method', name: m[1], line: i + 1, indent })
      }
    }
  }
  return out
}

function parseRust(content: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    let m
    m = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: indent > 0 ? 'method' : 'function', name: m[1], line: i + 1, indent }); continue }
    m = line.match(/^(?:pub\s+)?struct\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'class', name: m[1], line: i + 1, indent }); continue }
    m = line.match(/^(?:pub\s+)?enum\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'enum', name: m[1], line: i + 1, indent }); continue }
    m = line.match(/^(?:pub\s+)?trait\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'interface', name: m[1], line: i + 1, indent }); continue }
    m = line.match(/^(?:pub\s+)?type\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'type', name: m[1], line: i + 1, indent }); continue }
    m = line.match(/^(?:pub\s+)?const\s+([A-Z_]\w*)/)
    if (m) { out.push({ kind: 'const', name: m[1], line: i + 1, indent }); continue }
  }
  return out
}

function parseGo(content: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let m
    m = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: line.includes('(') && /^func\s+\(/.test(line) ? 'method' : 'function', name: m[1], line: i + 1, indent: 0 }); continue }
    m = line.match(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/)
    if (m) {
      const kind: SymbolKind = line.includes('interface') ? 'interface' : 'class'
      out.push({ kind, name: m[1], line: i + 1, indent: 0 }); continue
    }
    m = line.match(/^type\s+([A-Za-z_]\w*)/)
    if (m) { out.push({ kind: 'type', name: m[1], line: i + 1, indent: 0 }); continue }
  }
  return out
}

function parseSymbols(language: string, content: string): SymbolEntry[] {
  switch (language) {
    case 'python': return parsePython(content)
    case 'javascript':
    case 'typescript':
    case 'jsx':
    case 'tsx':
    case 'vue':
      return parseJsTs(content)
    case 'rust': return parseRust(content)
    case 'go': return parseGo(content)
    default: return []
  }
}

export function OutlinePanel({ activeFile, onGotoLine }: {
  activeFile: OpenTab | null
  onGotoLine: (line: number) => void
}) {
  const [filter, setFilter] = useState('')

  const symbols = useMemo(() => {
    if (!activeFile || !activeFile.content) return []
    return parseSymbols(activeFile.language, activeFile.content)
  }, [activeFile?.path, activeFile?.content, activeFile?.language])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return symbols
    return symbols.filter(s => s.name.toLowerCase().includes(q))
  }, [symbols, filter])

  if (!activeFile) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
        Aucun fichier ouvert.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6"/>
          <line x1="8" y1="12" x2="21" y2="12"/>
          <line x1="8" y1="18" x2="21" y2="18"/>
          <line x1="3" y1="6" x2="3.01" y2="6"/>
          <line x1="3" y1="12" x2="3.01" y2="12"/>
          <line x1="3" y1="18" x2="3.01" y2="18"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Plan du fichier</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({symbols.length})</span>
      </div>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filtrer les symboles..."
          style={{
            width: '100%', padding: '5px 10px', fontSize: 11,
            borderRadius: 4, background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none',
          }}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
            {symbols.length === 0
              ? `Aucun symbole détecté pour ce langage (${activeFile.language || 'inconnu'}).`
              : 'Aucun résultat pour ce filtre.'}
          </div>
        ) : filtered.map((s, i) => (
          <button key={`${s.line}-${s.name}-${i}`}
            onClick={() => onGotoLine(s.line)}
            title={`Ligne ${s.line}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '3px 12px',
              paddingLeft: 12 + Math.min(s.indent, 8) * 2,
              border: 'none', background: 'transparent', cursor: 'pointer',
              textAlign: 'left', color: 'var(--text-primary)', fontSize: 11.5,
              transition: 'background 0.08s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
            <span style={{ fontSize: 8, width: 10, color: KIND_COLOR[s.kind] }}>●</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.name}
            </span>
            <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{s.line}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// Ré-export pour tests unitaires éventuels
export { parseSymbols, KIND_ICON, KIND_COLOR }
