/**
 * Valkyrie — mini-renderer markdown.
 *
 * Sous-ensemble adapté aux descriptions de cartes (pas de code fences —
 * pas utile pour des tâches, garde le composant léger). Repris du renderer
 * de Chat.tsx pour garder une cohérence visuelle.
 *
 * Support : **bold**, *italic* / _italic_, `code`, [lbl](url), headings 1-3,
 * blockquotes, ul/ol, tables simples, paragraphes.
 */
import React from 'react'

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>)
    const tok = m[0]
    if (tok.startsWith('**') && tok.endsWith('**')) {
      out.push(<strong key={key++} style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else if (tok.startsWith('_') && tok.endsWith('_')) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else if (tok.startsWith('`') && tok.endsWith('`')) {
      out.push(
        <code key={key++} style={{
          padding: '1px 5px', borderRadius: 4, fontSize: '0.9em',
          fontFamily: 'JetBrains Mono, monospace',
          background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)',
          color: 'var(--scarlet)',
          border: '1px solid color-mix(in srgb, var(--scarlet) 15%, transparent)',
        }}>
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (linkMatch) {
        out.push(
          <a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--scarlet)', textDecoration: 'underline' }}>
            {linkMatch[1]}
          </a>
        )
      } else {
        out.push(<span key={key++}>{tok}</span>)
      }
    }
    last = pattern.lastIndex
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>)
  return out
}

export function MarkdownBlock({ text }: { text: string }) {
  if (!text) return null
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0
  let k = 0
  const pushKey = () => `v-md-${k++}`

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') { i++; continue }

    const h = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (h) {
      const level = h[1].length
      const inner = renderInline(h[2])
      if (level === 1) {
        nodes.push(<h3 key={pushKey()} style={{ fontSize: 'var(--font-lg)', fontWeight: 700, margin: '10px 0 4px', color: 'var(--text-primary)' }}>{inner}</h3>)
      } else if (level === 2) {
        nodes.push(<h4 key={pushKey()} style={{ fontSize: 13.5, fontWeight: 700, margin: '9px 0 3px', color: 'var(--text-primary)' }}>{inner}</h4>)
      } else {
        nodes.push(<h5 key={pushKey()} style={{ fontSize: 12.5, fontWeight: 700, margin: '8px 0 2px', color: 'var(--text-primary)' }}>{inner}</h5>)
      }
      i++; continue
    }

    if (trimmed.startsWith('>')) {
      const qLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      nodes.push(
        <blockquote key={pushKey()} style={{
          margin: '6px 0', padding: '4px 10px',
          borderLeft: '2px solid var(--scarlet)',
          background: 'color-mix(in srgb, var(--scarlet) 6%, transparent)',
          color: 'var(--text-secondary)', fontStyle: 'italic',
          fontSize: 11.5,
        }}>
          {renderInline(qLines.join(' '))}
        </blockquote>
      )
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''))
        i++
      }
      nodes.push(
        <ul key={pushKey()} style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'disc' }}>
          {items.map((it, j) => <li key={j} style={{ margin: '2px 0', lineHeight: 1.55 }}>{renderInline(it)}</li>)}
        </ul>
      )
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      nodes.push(
        <ol key={pushKey()} style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'decimal' }}>
          {items.map((it, j) => <li key={j} style={{ margin: '2px 0', lineHeight: 1.55 }}>{renderInline(it)}</li>)}
        </ol>
      )
      continue
    }

    // Paragraphe : avale les lignes consécutives non-spéciales.
    const pLines: string[] = []
    while (i < lines.length) {
      const l = lines[i]
      const lt = l.trim()
      if (lt === '') break
      if (/^(#{1,3})\s+/.test(lt)) break
      if (lt.startsWith('>')) break
      if (/^[-*]\s+/.test(lt)) break
      if (/^\d+\.\s+/.test(lt)) break
      pLines.push(l)
      i++
    }
    if (pLines.length > 0) {
      nodes.push(
        <p key={pushKey()} style={{ margin: '4px 0', lineHeight: 1.55, fontSize: 'var(--font-sm)' }}>
          {renderInline(pLines.join('\n'))}
        </p>
      )
    }
  }

  return <>{nodes}</>
}
