import { useState, useEffect } from 'react'
import type { OpenTab } from '../types'
import { apiFetch, fmtSize, renderMarkdown, sanitizeSvg } from '../utils'

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN PREVIEW
// ═══════════════════════════════════════════════════════════════════════════════

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.7 }}>
      <div style={{ maxWidth: 700 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE PREVIEW — split view latéral (markdown, html, svg, json, xml, css)
// Avec bouton de réduction (collapse) et fermeture.
// ═══════════════════════════════════════════════════════════════════════════════

export function LivePreview({
  file, collapsed, onToggleCollapse, onClose,
}: {
  file: OpenTab
  collapsed: boolean
  onToggleCollapse: () => void
  onClose: () => void
}) {
  // État réduit : barre verticale fine avec bouton pour ré-élargir.
  if (collapsed) {
    return (
      <div style={{
        width: 28, flexShrink: 0, background: 'var(--bg-secondary)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '8px 0', gap: 8,
      }}>
        <button onClick={onToggleCollapse}
          title="Ré-élargir la preview"
          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{
          writingMode: 'vertical-rl', transform: 'rotate(180deg)',
          fontSize: 9, fontFamily: 'monospace', textTransform: 'uppercase',
          letterSpacing: 2, color: 'var(--text-muted)', marginTop: 4,
        }}>
          Preview · {file.language}
        </div>
      </div>
    )
  }

  // Barre d'en-tête + contenu selon type.
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 10px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)', flexShrink: 0,
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.5 }}>
          Preview · {file.language}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onToggleCollapse}
          title="Réduire"
          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button onClick={onClose}
          title="Fermer la preview"
          style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px', fontSize: 13 }}>
          ×
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <LivePreviewContent file={file} />
      </div>
    </div>
  )
}

export function LivePreviewContent({ file }: { file: OpenTab }) {
  const lang = file.language
  const content = file.content || ''

  if (lang === 'markdown') {
    return <MarkdownPreview content={content} />
  }

  if (lang === 'html' || lang === 'xml') {
    // iframe sandboxée — exécute le script user mais isolé du reste.
    // `allow-scripts` pour que le rendu JS marche ; pas de `allow-same-origin`
    // pour empêcher l'accès au localStorage/cookies de l'app.
    return (
      <iframe
        title="html-preview"
        srcDoc={content}
        sandbox="allow-scripts"
        style={{ flex: 1, border: 'none', background: '#fff' }}
      />
    )
  }

  if (lang === 'svg') {
    // Rendu SVG direct (avec sanitize minimal — on est dans une iframe-like
    // via dangerouslySetInnerHTML, même logique que ImagePreview existant).
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0c0f14', padding: 20, overflow: 'auto' }}>
        <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(content) }} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      </div>
    )
  }

  if (lang === 'json') {
    // Pretty-print + syntax highlight basique via <pre>.
    let pretty = content
    let error: string | null = null
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2)
    } catch (e: any) {
      error = e?.message || 'JSON invalide'
    }
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
        {error && (
          <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 6, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', fontFamily: 'inherit', fontSize: 11 }}>
            ⚠ {error}
          </div>
        )}
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{pretty}</pre>
      </div>
    )
  }

  if (lang === 'css') {
    // Pour le CSS, on injecte dans une iframe avec un sample minimal de HTML
    // pour que l'user visualise l'effet.
    const demoHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${content}</style></head><body>
      <h1>Heading 1</h1><h2>Heading 2</h2><p>Paragraph with <a href="#">link</a> and <strong>bold</strong>.</p>
      <button>Button</button> <input placeholder="Input"/>
      <div class="card">Custom <code>.card</code> class preview</div>
      <ul><li>List item 1</li><li>List item 2</li></ul>
    </body></html>`
    return (
      <iframe
        title="css-preview"
        srcDoc={demoHtml}
        sandbox="allow-scripts"
        style={{ flex: 1, border: 'none', background: '#fff' }}
      />
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
      Pas de preview disponible pour ce type.
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE PREVIEW
// ═══════════════════════════════════════════════════════════════════════════════

export function ImagePreview({ path }: { path: string }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    apiFetch<any>(`/preview?path=${encodeURIComponent(path)}`).then(d => { setData(d); setLoading(false) })
  }, [path])

  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>Chargement...</div>
  if (!data?.ok) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>{data?.error || 'Apercu indisponible'}</div>

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0c0f14', overflow: 'auto', padding: 20 }}>
      <div style={{ textAlign: 'center' }}>
        {data.type === 'svg'
          ? <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(data.content) }} style={{ maxWidth: '100%', maxHeight: '80vh' }} />
          : <img src={data.data} alt={path} style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 8, border: '1px solid #1e2633' }} />
        }
        <div style={{ marginTop: 12, fontSize: 11, color: '#8b949e' }}>{path} {data.size && `• ${fmtSize(data.size)}`}</div>
      </div>
    </div>
  )
}
