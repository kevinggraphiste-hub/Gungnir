/**
 * HuntR v3 — Perplexity-like Search for Gungnir
 *
 * Classique (free) : DuckDuckGo → formatted results, no LLM
 * Pro              : Tavily + LLM synthesis with inline [1][2] citations
 *
 * Per-user: each user needs their own Tavily key (free 1000/mo) + LLM provider.
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { useStore } from '@core/stores/appStore'
import { PrimaryButton, SecondaryButton } from '@core/components/ui'
import {
  ArrowRight, Loader2, Clock, Download, Plus, Sliders, X, Save,
  Bold, Italic, Underline, Strikethrough, Code, Link2, Quote, Minus,
  List, ListOrdered, Table as TableIcon, ChevronDown, Undo2, Redo2, Sparkles,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────

interface Citation {
  index: number
  url: string
  title: string
  snippet?: string
}

interface SearchResult {
  answer: string
  citations: Citation[]
  related_questions: string[]
  search_count: number
  pro_search: boolean
  topic: Topic
  engines: string[]
  time_ms: number
  model?: string
  error?: boolean
}

type Topic = 'web' | 'news' | 'academic' | 'code'

const TOPICS: { id: Topic; label: string; icon: string; desc: string }[] = [
  { id: 'web',      label: 'Web',        icon: 'globe',    desc: 'Recherche générale' },
  { id: 'news',     label: 'Actu',       icon: 'news',     desc: "Actualités récentes" },
  { id: 'academic', label: 'Académique', icon: 'book',     desc: 'Papiers & recherche' },
  { id: 'code',     label: 'Code',       icon: 'code',     desc: 'Dev, docs, StackOverflow' },
]

const TOPIC_LABELS: Record<Topic, string> = {
  web: 'Web', news: 'Actu', academic: 'Académique', code: 'Code',
}

interface LiveSource {
  title: string
  url: string
  snippet?: string
  source?: string
  providers?: string[]
}

interface HistoryEntry {
  id?: number
  query: string
  mode: string
  topic?: Topic
  sources_count: number
  time_ms: number
  timestamp: number
  answer?: string
  citations?: Citation[]
  related_questions?: string[]
  engines?: string[]
  model?: string
  is_favorite?: boolean
}

interface UserCapabilities {
  has_tavily: boolean
  has_any_search_key: boolean
  has_llm: boolean
  provider: string | null
  model: string | null
}

interface ProviderStatus {
  id: string               // "brave", "tavily", "duckduckgo", ...
  label: string            // "Brave Search"
  needs_key: boolean       // true si une clé API est requise
  has_requirements: boolean // clé/URL configurée
  enabled: boolean         // toggle user
  supports_classic: boolean // utilisable en mode Classique (gratuit)
  weight: number
}

const API = '/api/plugins/browser'

// ── WYSIWYG template helpers ─────────────────────────────────────────────
// Le custom_format est desormais stocke en Markdown brut. L'editeur
// contenteditable produit du HTML qu'on convertit en Markdown a la sauvegarde,
// et on reconvertit Markdown->HTML au chargement. La detection JSON (legacy
// block editor) est conservee pour migrer les utilisateurs existants
// automatiquement vers du Markdown.

const DEFAULT_MARKDOWN_TEMPLATE = `# {{TITRE}}

## Contexte
Paragraphe de 5 à 8 phrases qui posent le sujet, citations [1][2] dans le texte.

## Analyse
Paragraphe de 5 à 8 phrases détaillant les enjeux, citations [3][4].

## Conclusion
Paragraphe de 3 à 5 phrases de synthèse.
`

function escapeHtmlShort(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Convert legacy block JSON into Markdown so existing users auto-migrate
// to the new WYSIWYG without losing their template.
function legacyBlocksToMarkdown(raw: string): string | null {
  if (!raw || !raw.trim().startsWith('[')) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const parts: string[] = []
    for (const b of parsed) {
      if (!b || typeof b !== 'object') continue
      const t = b.type
      const text = (b.text || '').trim()
      if (t === 'h1') parts.push(`# ${text || 'Titre principal'}`)
      else if (t === 'h2') parts.push(`## ${text || 'Section'}`)
      else if (t === 'h3') parts.push(`### ${text || 'Sous-section'}`)
      else if (t === 'paragraph') parts.push(text || 'Paragraphe de synthèse, citations [1][2] dans le texte.')
      else if (t === 'bullets') parts.push(`- ${text || 'Item 1, citation [1]'}\n- Item 2, citation [2]\n- Item 3`)
      else if (t === 'numbered') parts.push(`1. ${text || 'Étape 1, citation [1]'}\n2. Étape 2, citation [2]\n3. Étape 3`)
      else if (t === 'table') {
        const cols = (Array.isArray(b.columns) && b.columns.length ? b.columns : ['Colonne 1', 'Colonne 2']).map((c: any) => String(c).trim() || 'Col')
        parts.push(
          '| ' + cols.join(' | ') + ' |\n' +
          '|' + cols.map(() => '---').join('|') + '|\n' +
          '| ' + cols.map(() => '…').join(' | ') + ' |'
        )
      }
    }
    return parts.length ? parts.join('\n\n') : null
  } catch { return null }
}

// Markdown rendered as a chip in the WYSIWYG → LLM substitues its content.
// Supported variables:
//   {{TITRE}} → dynamic title reformulated from the search query.
function renderVariableChip(name: string, label: string): string {
  return `<span class="huntr-variable" data-var="${escapeHtmlShort(name)}" contenteditable="false">${escapeHtmlShort(label)}</span>`
}

function mdToHtml(md: string): string {
  if (!md) return ''
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  const inline = (s: string): string => {
    let v = escapeHtmlShort(s)
    v = v.replace(/\{\{TITRE\}\}/g, renderVariableChip('TITRE', 'Titre dynamique'))
    v = v.replace(/`([^`]+)`/g, '<code>$1</code>')
    v = v.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    v = v.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    v = v.replace(/~~([^~]+)~~/g, '<s>$1</s>')
    v = v.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return v
  }
  while (i < lines.length) {
    const l = lines[i]
    if (l.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(escapeHtmlShort(lines[i])); i++ }
      i++
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`)
      continue
    }
    if (l.startsWith('### ')) { out.push(`<h3>${inline(l.slice(4))}</h3>`); i++; continue }
    if (l.startsWith('## '))  { out.push(`<h2>${inline(l.slice(3))}</h2>`); i++; continue }
    if (l.startsWith('# '))   { out.push(`<h1>${inline(l.slice(2))}</h1>`); i++; continue }
    if (l.startsWith('> ')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) { buf.push(lines[i].slice(2)); i++ }
      out.push(`<blockquote>${inline(buf.join('<br>'))}</blockquote>`)
      continue
    }
    if (/^---+$/.test(l)) { out.push('<hr>'); i++; continue }
    if (/^- /.test(l)) {
      const buf: string[] = []
      while (i < lines.length && /^- /.test(lines[i])) { buf.push(lines[i].slice(2)); i++ }
      out.push('<ul>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ul>')
      continue
    }
    if (/^\d+\. /.test(l)) {
      const buf: string[] = []
      while (i < lines.length && /^\d+\. /.test(lines[i])) { buf.push(lines[i].replace(/^\d+\. /, '')); i++ }
      out.push('<ol>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ol>')
      continue
    }
    if (/^\|.*\|\s*$/.test(l)) {
      const rows: string[] = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++ }
      const cells = rows.map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
      const hasSep = cells[1] && cells[1].every(c => /^-+$/.test(c))
      const head = hasSep ? cells[0] : null
      const body = hasSep ? cells.slice(2) : cells
      let tbl = '<table>'
      if (head) tbl += '<thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>'
      tbl += '<tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>'
      out.push(tbl)
      continue
    }
    if (l.trim()) { out.push(`<p>${inline(l)}</p>`); i++; continue }
    i++
  }
  return out.join('\n')
}

function htmlToMd(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent || '')
    if (node.nodeType !== 1) return ''
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    const inner = Array.from(el.childNodes).map(walk).join('')
    switch (tag) {
      case 'h1': return `# ${inner}\n\n`
      case 'h2': return `## ${inner}\n\n`
      case 'h3': return `### ${inner}\n\n`
      case 'h4': case 'h5': case 'h6': return `### ${inner}\n\n`
      case 'p':  return `${inner}\n\n`
      case 'br': return '\n'
      case 'strong': case 'b': return `**${inner}**`
      case 'em': case 'i': return `*${inner}*`
      case 's': case 'strike': case 'del': return `~~${inner}~~`
      case 'u': return inner
      case 'a': return `[${inner}](${el.getAttribute('href') || ''})`
      case 'code':
        if (el.parentElement && el.parentElement.tagName === 'PRE') return inner
        return `\`${inner}\``
      case 'pre':
        return `\`\`\`\n${el.textContent || ''}\n\`\`\`\n\n`
      case 'blockquote':
        return inner.split('\n').filter(Boolean).map(x => `> ${x}`).join('\n') + '\n\n'
      case 'hr': return '---\n\n'
      case 'ul':
        return Array.from(el.children).map(li => `- ${walk(li).trim()}`).join('\n') + '\n\n'
      case 'ol':
        return Array.from(el.children).map((li, idx) => `${idx + 1}. ${walk(li).trim()}`).join('\n') + '\n\n'
      case 'li': return inner
      case 'span': {
        const v = el.getAttribute('data-var')
        if (v) return `{{${v}}}`
        return inner
      }
      case 'table': {
        const rows = Array.from(el.querySelectorAll('tr'))
        if (!rows.length) return ''
        const cellsAt = (tr: Element) => Array.from(tr.children).map(c => (c.textContent || '').trim() || ' ')
        const head = cellsAt(rows[0])
        let md = '| ' + head.join(' | ') + ' |\n'
        md += '|' + head.map(() => '---').join('|') + '|\n'
        for (let r = 1; r < rows.length; r++) {
          md += '| ' + cellsAt(rows[r]).join(' | ') + ' |\n'
        }
        return md + '\n'
      }
      default: return inner
    }
  }
  return walk(tmp).replace(/\n{3,}/g, '\n\n').trim()
}

// Citations factices pour la preview WYSIWYG — le rendu exact que verra
// l'utilisateur une fois la réponse générée (vignettes [1]…[5] cliquables).
const SAMPLE_CITATIONS: Citation[] = [
  { index: 1, url: 'https://example.com/source-1', title: 'Source 1 — exemple',    snippet: 'Aperçu de la source 1 tel qu\'il apparaîtra au survol.' },
  { index: 2, url: 'https://example.com/source-2', title: 'Source 2 — exemple',    snippet: 'Aperçu de la source 2 avec un extrait de contenu représentatif.' },
  { index: 3, url: 'https://example.com/source-3', title: 'Source 3 — exemple',    snippet: 'Aperçu de la source 3.' },
  { index: 4, url: 'https://example.com/source-4', title: 'Source 4 — exemple',    snippet: 'Aperçu de la source 4.' },
  { index: 5, url: 'https://example.com/source-5', title: 'Source 5 — exemple',    snippet: 'Aperçu de la source 5.' },
]

const SUGGESTIONS = [
  "Quelles sont les dernières avancées en IA ?",
  "Compare Python vs Rust pour le backend",
  "Comment fonctionne le quantum computing ?",
  "Actualités tech cette semaine",
  "Implémenter JWT authentication en Node.js",
  "Microservices vs monolith : différences",
]

const ENGINE_COLORS: Record<string, string> = {
  duckduckgo: '#de5833',
  tavily: '#6366f1',
  brave: '#fb542b',
  exa: '#22c55e',
  serper: '#0ea5e9',
  serpapi: '#3b82f6',
  kagi: '#f59e0b',
  bing: '#008373',
  searxng: '#6a1d9a',
}

// ── Helpers ───────────────────────────────────────────────────────────────

function TopicIcon({ kind, active }: { kind: string; active: boolean }) {
  const color = active ? 'var(--scarlet)' : 'currentColor'
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (kind === 'globe') {
    return (<svg {...common}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>)
  }
  if (kind === 'news') {
    return (<svg {...common}><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/>
      <path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6z"/></svg>)
  }
  if (kind === 'book') {
    return (<svg {...common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>)
  }
  if (kind === 'code') {
    return (<svg {...common}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>)
  }
  return null
}

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000) - ts)
  if (diff < 60) return "à l'instant"
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)}min`
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`
  return `il y a ${Math.floor(diff / 86400)}j`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function markdownToHtml(md: string, citations: Citation[]): string {
  if (!md) return ''
  const citMap = new Map<number, Citation>()
  citations.forEach(c => citMap.set(c.index, c))

  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  const codeBuf: string[] = []

  const inline = (txt: string): string => {
    let s = escapeHtml(txt)
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    s = s.replace(/\[(\d+)\]/g, (_m, idx) => {
      const c = citMap.get(parseInt(idx))
      const href = c?.url || '#'
      return `<sup><a href="${escapeHtml(href)}" class="hr-cite">[${idx}]</a></sup>`
    })
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    return s
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
        codeBuf.length = 0
        inCode = false
      } else { inCode = true }
      continue
    }
    if (inCode) { codeBuf.push(line); continue }
    if (line.startsWith('### ')) out.push(`<h4>${inline(line.slice(4))}</h4>`)
    else if (line.startsWith('## ')) out.push(`<h3>${inline(line.slice(3))}</h3>`)
    else if (line.startsWith('# ')) out.push(`<h2>${inline(line.slice(2))}</h2>`)
    else if (/^[-*]\s/.test(line)) out.push(`<li>${inline(line.slice(2))}</li>`)
    else if (!line.trim()) out.push('')
    else out.push(`<p>${inline(line)}</p>`)
  }
  return out.join('\n')
}

// ── Export helpers ────────────────────────────────────────────────────────

type ExportFormat = 'pdf' | 'html' | 'md' | 'json' | 'txt'

function slugify(s: string): string {
  return (s || 'huntr-export')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'huntr-export'
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// Styles ScarletWolf pour les exports HTML/PDF. Deux variantes :
// - `light`  : fond crème, idéal pour l'impression (PDF) — les navigateurs
//              masquent les fonds par défaut, donc on DOIT rester lisible
//              sans couleur de fond.
// - `dark`   : fond noir + texte blanc + accents scarlet, clone visuel
//              de l'app (utilisé pour le download HTML autonome).
//
// L'identité commune : typographie Inter, la signature "Hunt" + "R" rouge,
// barre scarlet sous le header, citations superscript en scarlet, sources
// dans un bloc bordé scarlet avec l'index en rouge majuscule.
const HUNTR_EXPORT_CSS_LIGHT = `
  @page { margin: 18mm; }
  :root { color-scheme: light; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1c1c1c; background: #faf7f2; line-height: 1.6; max-width: 780px; margin: 0 auto; padding: 24px; }
  header { border-bottom: 3px solid #dc2626; padding-bottom: 14px; margin-bottom: 22px; position: relative; }
  header::before { content: ''; position: absolute; bottom: -3px; left: 0; width: 60px; height: 3px; background: #7a1010; }
  header h1 { margin: 0 0 2px; font-size: 26px; font-weight: 800; letter-spacing: -0.02em; color: #1c1c1c; }
  header h1 .r { color: #dc2626; text-shadow: 0 0 1px rgba(220,38,38,0.2); }
  header h1 .mark { display: inline-block; vertical-align: middle; margin-left: 8px; width: 18px; height: 18px; }
  header .q { font-size: 15px; color: #2b2620; margin: 8px 0 4px; font-weight: 600; }
  header .meta { font-size: 10.5px; color: #6b5b4a; font-variant: all-small-caps; letter-spacing: 0.03em; }
  main { margin-top: 10px; }
  h2 { font-size: 17px; font-weight: 700; color: #1c1c1c; margin: 20px 0 8px; padding-bottom: 4px; border-bottom: 1px solid rgba(220,38,38,0.25); }
  h3 { font-size: 14px; font-weight: 700; color: #2b2620; margin: 14px 0 4px; }
  h4 { font-size: 13px; font-weight: 600; color: #2b2620; margin: 10px 0 3px; }
  p { margin: 4px 0 10px; font-size: 12.5px; }
  li { font-size: 12.5px; margin: 3px 0; }
  strong { color: #1c1c1c; }
  a { color: #b91c1c; text-decoration: none; }
  a:hover { text-decoration: underline; }
  a.hr-cite { color: #dc2626; font-weight: 700; font-size: 0.85em; }
  sup a.hr-cite { text-decoration: none; }
  code { background: #ece6db; color: #7a1010; padding: 1px 5px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; }
  pre { background: #ece6db; color: #2b2620; padding: 10px; border-radius: 6px; overflow: auto; font-family: 'JetBrains Mono', monospace; font-size: 11px; border-left: 3px solid #dc2626; }
  blockquote { border-left: 3px solid #dc2626; padding-left: 12px; margin: 10px 0; color: #4a3f35; font-style: italic; }
  .sources { margin-top: 28px; padding-top: 14px; border-top: 2px solid #dc2626; }
  .sources h2 { border: none; margin-top: 0; color: #7a1010; }
  .sources ol { list-style: none; padding: 0; counter-reset: none; }
  .sources li { margin: 8px 0; padding: 10px 12px; background: #f0eadf; border-left: 3px solid #dc2626; border-radius: 3px; }
  .sources .idx { font-family: 'JetBrains Mono', monospace; font-weight: 700; color: #dc2626; margin-right: 6px; letter-spacing: -0.02em; }
  .sources a { color: #1c1c1c; font-weight: 600; }
  .sources .host { font-size: 10.5px; color: #8a7a6a; margin-top: 3px; font-variant: all-small-caps; letter-spacing: 0.03em; }
  footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #ddd5c8; font-size: 10px; color: #8a7a6a; text-align: center; font-variant: all-small-caps; letter-spacing: 0.06em; }
  footer .dot { color: #dc2626; margin: 0 5px; }
`

const HUNTR_EXPORT_CSS_DARK = `
  @page { margin: 18mm; }
  :root { color-scheme: dark; }
  body { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #f5f5f5; background: #080808; line-height: 1.65; max-width: 820px; margin: 0 auto; padding: 32px 28px; }
  header { border-bottom: 3px solid #dc2626; padding-bottom: 16px; margin-bottom: 24px; position: relative; box-shadow: 0 1px 0 rgba(220,38,38,0.15); }
  header::before { content: ''; position: absolute; bottom: -3px; left: 0; width: 80px; height: 3px; background: #ef4444; box-shadow: 0 0 12px rgba(220,38,38,0.5); }
  header h1 { margin: 0 0 3px; font-size: 28px; font-weight: 800; letter-spacing: -0.02em; color: #f5f5f5; }
  header h1 .r { color: #ef4444; text-shadow: 0 0 14px rgba(220,38,38,0.5); }
  header h1 .mark { display: inline-block; vertical-align: middle; margin-left: 10px; width: 20px; height: 20px; }
  header .q { font-size: 16px; color: #e5e5e5; margin: 10px 0 6px; font-weight: 600; }
  header .meta { font-size: 11px; color: #a3a3a3; font-variant: all-small-caps; letter-spacing: 0.05em; }
  main { margin-top: 14px; }
  h2 { font-size: 18px; font-weight: 700; color: #f5f5f5; margin: 22px 0 10px; padding-bottom: 5px; border-bottom: 1px solid rgba(220,38,38,0.3); }
  h3 { font-size: 15px; font-weight: 700; color: #e5e5e5; margin: 16px 0 6px; }
  h4 { font-size: 13.5px; font-weight: 600; color: #d4d4d4; margin: 12px 0 4px; }
  p { margin: 6px 0 12px; font-size: 13.5px; color: #d4d4d4; }
  li { font-size: 13.5px; margin: 4px 0; color: #d4d4d4; }
  strong { color: #f5f5f5; }
  a { color: #f87171; text-decoration: none; }
  a:hover { text-decoration: underline; text-decoration-color: #ef4444; }
  a.hr-cite { color: #ef4444; font-weight: 700; font-size: 0.85em; text-shadow: 0 0 6px rgba(220,38,38,0.4); }
  sup a.hr-cite { text-decoration: none; }
  code { background: #1a1a1a; color: #f87171; padding: 1px 6px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 12px; border: 1px solid #2a2a2a; }
  pre { background: #111111; color: #e5e5e5; padding: 12px; border-radius: 6px; overflow: auto; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; border-left: 3px solid #dc2626; }
  blockquote { border-left: 3px solid #dc2626; padding-left: 14px; margin: 12px 0; color: #a3a3a3; font-style: italic; }
  .sources { margin-top: 32px; padding-top: 16px; border-top: 2px solid #dc2626; }
  .sources h2 { border: none; margin-top: 0; color: #ef4444; }
  .sources ol { list-style: none; padding: 0; }
  .sources li { margin: 10px 0; padding: 12px 14px; background: #131313; border-left: 3px solid #dc2626; border-radius: 3px; }
  .sources .idx { font-family: 'JetBrains Mono', monospace; font-weight: 700; color: #ef4444; margin-right: 7px; letter-spacing: -0.02em; }
  .sources a { color: #e5e5e5; font-weight: 600; }
  .sources a:hover { color: #f87171; }
  .sources .host { font-size: 11px; color: #666666; margin-top: 4px; font-variant: all-small-caps; letter-spacing: 0.04em; }
  footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #2a2a2a; font-size: 10.5px; color: #666666; text-align: center; font-variant: all-small-caps; letter-spacing: 0.06em; }
  footer .dot { color: #dc2626; margin: 0 6px; }
`

// SVG wolf minimaliste intégré en inline — petit claw/crest rouge. Pas de
// dépendance réseau (les exports fonctionnent offline).
const HUNTR_WOLF_MARK = `<svg class="mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 10 L6 4 L9 8 L12 3 L15 8 L18 4 L20 10 L22 14 L18 13 L17 19 L13 16 L12 21 L11 16 L7 19 L6 13 L2 14 Z" fill="#dc2626" stroke="#b91c1c" stroke-width="0.5" stroke-linejoin="round"/></svg>`

function buildHuntRHtml(query: string, result: SearchResult, variant: 'light' | 'dark' = 'light'): string {
  const body = markdownToHtml(result.answer || '', result.citations || [])
  const sources = (result.citations || []).map(c => {
    const host = (() => { try { return new URL(c.url).hostname.replace('www.', '') } catch { return c.url } })()
    return `<li><span class="idx">[${c.index}]</span> <a href="${escapeHtml(c.url)}">${escapeHtml(c.title || host)}</a><div class="host">${escapeHtml(host)}</div></li>`
  }).join('')
  const topicLbl = TOPIC_LABELS[(result.topic || 'web') as Topic] || 'Web'
  const meta = [
    result.pro_search ? 'Mode Pro' : 'Mode Classique',
    topicLbl,
    ...(result.engines || []),
    result.model || '',
    `${result.search_count} sources`,
    new Date().toLocaleString('fr-FR'),
  ].filter(Boolean).map(escapeHtml).join(' • ')
  const css = variant === 'dark' ? HUNTR_EXPORT_CSS_DARK : HUNTR_EXPORT_CSS_LIGHT

  return `<!doctype html>
<html lang="fr" data-theme="${variant === 'dark' ? 'dark-scarlet' : 'light-scarlet'}"><head><meta charset="utf-8"><title>HuntR — ${escapeHtml(query)}</title>
<style>${css}</style></head><body>
<header>
  <h1>Hunt<span class="r">R</span>${HUNTR_WOLF_MARK}</h1>
  <div class="q">${escapeHtml(query)}</div>
  <div class="meta">${meta}</div>
</header>
<main>${body}</main>
<section class="sources"><h2>Sources (${(result.citations || []).length})</h2><ol>${sources}</ol></section>
<footer>Généré par Hunt<span class="dot">●</span>R <span class="dot">●</span> ScarletWolf Gungnir</footer>
</body></html>`
}

function buildHuntRMarkdown(query: string, result: SearchResult): string {
  const answer = (result.answer || '').trim()
  const sources = (result.citations || []).map(c => {
    const title = c.title || c.url
    return `[${c.index}] ${title} — ${c.url}`
  }).join('\n')
  const topicLbl = TOPIC_LABELS[(result.topic || 'web') as Topic] || 'Web'
  const metaLine = [
    result.pro_search ? 'Pro' : 'Classique',
    topicLbl,
    result.model || '',
    `${result.search_count} sources`,
    new Date().toLocaleString('fr-FR'),
  ].filter(Boolean).join(' · ')
  return (
    `# ${query}\n\n` +
    `> ${metaLine}\n\n` +
    `${answer}\n\n` +
    (sources ? `---\n\n## Sources\n\n${sources}\n` : '')
  )
}

function buildHuntRJson(query: string, result: SearchResult): string {
  const payload = {
    query,
    generated_at: new Date().toISOString(),
    pro_search: !!result.pro_search,
    topic: result.topic || 'web',
    model: result.model || null,
    engines: result.engines || [],
    search_count: result.search_count || 0,
    time_ms: result.time_ms || 0,
    answer: result.answer || '',
    citations: result.citations || [],
    related_questions: result.related_questions || [],
  }
  return JSON.stringify(payload, null, 2)
}

function buildHuntRText(query: string, result: SearchResult): string {
  // Conversion Markdown → texte brut : strip des marqueurs syntaxiques en
  // gardant le texte utile. On NE remplace PAS les citations [n] : elles sont
  // informatives dans un export texte aussi.
  const md = (result.answer || '')
  const stripped = md
    .replace(/^#{1,6}\s+/gm, '')               // # titles → texte nu
    .replace(/\*\*(.+?)\*\*/g, '$1')           // bold
    .replace(/\*(.+?)\*/g, '$1')               // italic
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/```[\s\S]*?```/g, m => m.replace(/```[a-z]*\n?|\n?```/g, '')) // fences
    .replace(/^\s*[-*]\s+/gm, '- ')            // bullets (keep marker)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // links
    .replace(/\n{3,}/g, '\n\n')                // compress excess blank lines
  const sources = (result.citations || []).map(c => {
    const title = c.title || c.url
    return `[${c.index}] ${title}\n    ${c.url}`
  }).join('\n\n')
  const topicLbl = TOPIC_LABELS[(result.topic || 'web') as Topic] || 'Web'
  const meta = [
    result.pro_search ? 'Pro' : 'Classique',
    topicLbl,
    result.model || '',
    `${result.search_count} sources`,
    new Date().toLocaleString('fr-FR'),
  ].filter(Boolean).join(' · ')
  return (
    `${query}\n` +
    `${'='.repeat(Math.min(80, query.length))}\n` +
    `${meta}\n\n` +
    `${stripped.trim()}\n\n` +
    (sources ? `----------\nSources\n\n${sources}\n` : '')
  )
}

function exportAs(format: ExportFormat, query: string, result: SearchResult) {
  const base = slugify(query)
  if (format === 'pdf') {
    exportAsPdf(query, result)
    return
  }
  if (format === 'html') {
    // HTML autonome = clone visuel de l'app (dark ScarletWolf).
    downloadBlob(buildHuntRHtml(query, result, 'dark'), `${base}.html`, 'text/html;charset=utf-8')
    return
  }
  if (format === 'md') {
    downloadBlob(buildHuntRMarkdown(query, result), `${base}.md`, 'text/markdown;charset=utf-8')
    return
  }
  if (format === 'json') {
    downloadBlob(buildHuntRJson(query, result), `${base}.json`, 'application/json;charset=utf-8')
    return
  }
  if (format === 'txt') {
    downloadBlob(buildHuntRText(query, result), `${base}.txt`, 'text/plain;charset=utf-8')
    return
  }
}

function exportAsPdf(query: string, result: SearchResult) {
  // Variante 'light' : fond crème, accents scarlet. Les navigateurs masquent
  // les fonds par défaut à l'impression — un PDF light reste lisible sans
  // que l'user ait à activer "Imprimer les couleurs d'arrière-plan".
  const html = buildHuntRHtml(query, result, 'light').replace(
    '</body></html>',
    '<script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));</script></body></html>'
  )
  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) {
    alert('Popup bloquée. Autorisez les popups pour exporter en PDF.')
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
}

// ── Export Menu (dropdown) ────────────────────────────────────────────────

const EXPORT_FORMATS: { id: ExportFormat; label: string; desc: string }[] = [
  { id: 'pdf',  label: 'PDF',      desc: 'Impression navigateur → PDF' },
  { id: 'html', label: 'HTML',     desc: 'Page web autonome (stylée)' },
  { id: 'md',   label: 'Markdown', desc: 'Pour coller dans Obsidian, Notion…' },
  { id: 'json', label: 'JSON',     desc: 'Données brutes (citations, méta…)' },
  { id: 'txt',  label: 'Texte',    desc: 'Brut sans mise en forme' },
]

function ExportMenu({ query, result }: { query: string; result: SearchResult }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const pick = (f: ExportFormat) => {
    setOpen(false)
    exportAs(f, query, result)
  }

  return (
    <div ref={ref} style={{ marginLeft: 'auto', position: 'relative' }}>
      <SecondaryButton
        size="sm"
        icon={<Download size={11} />}
        onClick={() => setOpen(v => !v)}
        title="Exporter la réponse"
        style={{
          padding: '3px 10px',
          fontSize: 10,
          color: 'var(--scarlet)',
          border: '1px solid var(--scarlet)',
        }}
      >
        Exporter ▾
      </SecondaryButton>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 4px)',
            minWidth: 220,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            zIndex: 20,
            padding: 4,
          }}
        >
          {EXPORT_FORMATS.map(f => (
            <button
              key={f.id}
              onClick={() => pick(f.id)}
              role="menuitem"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                borderRadius: 6,
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>{f.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{f.desc}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────

export default function HuntRPlugin() {
  const { selectedProvider, selectedModel } = useStore()

  const [query, setQuery] = useState('')
  const [proSearch, setProSearch] = useState(false)
  const [topic, setTopic] = useState<Topic>('web')
  const [searching, setSearching] = useState(false)
  const [status, setStatus] = useState('')
  const [currentStep, setCurrentStep] = useState(0)
  const [totalSteps, setTotalSteps] = useState(0)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [liveSources, setLiveSources] = useState<LiveSource[]>([])
  const [error, setError] = useState('')
  const [caps, setCaps] = useState<UserCapabilities | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null)
  // Per-user custom response format (pro mode), desormais stocke en Markdown
  // brut dans user_settings.huntr_config.custom_format. L'editeur WYSIWYG
  // edite du HTML en interne et serialise en Markdown a la sauvegarde.
  const [customFormat, setCustomFormat] = useState('')
  const [draftMarkdown, setDraftMarkdown] = useState('')
  const [showFormatEditor, setShowFormatEditor] = useState(false)
  const [savingFormat, setSavingFormat] = useState(false)

  // ── Multi-providers (Brave, Exa, Serper…) : toggle par user ──────────
  const [providersStatus, setProvidersStatus] = useState<ProviderStatus[]>([])
  const [showProvidersPanel, setShowProvidersPanel] = useState(false)
  const [savingProviders, setSavingProviders] = useState(false)
  const [formatFlash, setFormatFlash] = useState<'ok' | 'err' | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshHistory = useCallback(() => {
    const qs = favoritesOnly ? '?limit=30&favorites_only=true' : '?limit=30'
    fetch(`${API}/history${qs}`)
      .then(r => r.json())
      .then(d => setHistory(d.history || []))
      .catch(() => {})
  }, [favoritesOnly])

  // ── Init: check user capabilities ─────────────────────────────────
  useEffect(() => {
    fetch(`${API}/user-capabilities`)
      .then(r => r.json())
      .then(d => setCaps(d))
      .catch(() => {})
    fetch(`${API}/preferences`)
      .then(r => r.json())
      .then(d => {
        const raw = (d?.custom_format || '') as string
        // Migration silencieuse : si on recoit du JSON block-based legacy,
        // on le convertit en Markdown pour le nouvel editeur WYSIWYG.
        const migrated = legacyBlocksToMarkdown(raw)
        const md = migrated ?? raw
        setCustomFormat(md)
        setDraftMarkdown(md)
        // Si on a migre, on resynchronise le backend avec la version Markdown
        // pour que la prochaine lecture ne passe plus par le parsing JSON.
        if (migrated !== null) {
          fetch(`${API}/preferences`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_format: migrated }),
          }).catch(() => {})
        }
      })
      .catch(() => {})
    fetch(`${API}/providers`)
      .then(r => r.json())
      .then(d => setProvidersStatus((d?.providers as ProviderStatus[]) || []))
      .catch(() => {})
  }, [])

  // Toggle un provider (optimiste + persiste) — rafraîchit l'état complet
  // depuis le serveur après la sauvegarde pour rester synchro avec la logique
  // de défauts (un user qui n'a encore rien touché hérite de DDG+Tavily auto).
  const toggleProvider = useCallback(async (id: string, nextEnabled: boolean) => {
    setSavingProviders(true)
    // Optimiste : on met à jour l'UI avant la réponse serveur
    setProvidersStatus(prev => prev.map(p => p.id === id ? { ...p, enabled: nextEnabled } : p))
    try {
      // On construit le dict providers à partir de l'état courant + le toggle
      const payload: Record<string, { enabled: boolean }> = {}
      for (const p of providersStatus) {
        payload[p.id] = { enabled: p.id === id ? nextEnabled : p.enabled }
      }
      await fetch(`${API}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: payload }),
      })
      // Resync depuis le serveur (gère le cas où un provider a perdu sa clé)
      const r = await fetch(`${API}/providers`)
      const d = await r.json()
      setProvidersStatus((d?.providers as ProviderStatus[]) || [])
    } catch {
      // En cas d'erreur, on recharge l'état serveur pour annuler l'optimisme
      fetch(`${API}/providers`).then(r => r.json())
        .then(d => setProvidersStatus((d?.providers as ProviderStatus[]) || []))
        .catch(() => {})
    } finally {
      setSavingProviders(false)
    }
  }, [providersStatus])

  const persistFormat = useCallback(async (raw: string) => {
    setSavingFormat(true)
    setFormatFlash(null)
    try {
      const resp = await fetch(`${API}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_format: raw }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      const fmt = (data?.custom_format || '') as string
      setCustomFormat(fmt)
      setDraftMarkdown(fmt)
      setFormatFlash('ok')
    } catch {
      setFormatFlash('err')
    } finally {
      setSavingFormat(false)
      setTimeout(() => setFormatFlash(null), 2500)
    }
  }, [])

  const saveCustomFormat = useCallback((md: string) => persistFormat(md.trim()), [persistFormat])
  const resetCustomFormat = useCallback(() => { setDraftMarkdown(''); return persistFormat('') }, [persistFormat])
  const loadExampleFormat = useCallback(() => { setDraftMarkdown(DEFAULT_MARKDOWN_TEMPLATE) }, [])

  // ── Reload history when filter changes ────────────────────────────
  useEffect(() => { refreshHistory() }, [refreshHistory])

  const toggleFavorite = useCallback(async (entry: HistoryEntry) => {
    if (!entry.id) return
    const next = !entry.is_favorite
    // Optimistic update
    setHistory(h => h.map(x => x.id === entry.id ? { ...x, is_favorite: next } : x))
    try {
      await fetch(`${API}/history/${entry.id}/favorite`, {
        method: next ? 'POST' : 'DELETE',
      })
    } catch {
      // Revert on error
      setHistory(h => h.map(x => x.id === entry.id ? { ...x, is_favorite: !next } : x))
    }
  }, [])

  const deleteEntry = useCallback(async (id: number) => {
    setHistory(h => h.filter(x => x.id !== id))
    try {
      await fetch(`${API}/history/${id}`, { method: 'DELETE' })
    } catch {
      refreshHistory()
    }
  }, [refreshHistory])

  // ── Search ────────────────────────────────────────────────────────
  const doSearch = useCallback(async (overrideQuery?: string) => {
    const q = (overrideQuery || query).trim()
    if (!q) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setSearching(true)
    setStatus('Initialisation...')
    setCurrentStep(0)
    setTotalSteps(0)
    setResult(null)
    setLiveSources([])
    setError('')
    if (overrideQuery) setQuery(overrideQuery)

    try {
      const resp = await fetch(`${API}/search/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          pro_search: proSearch,
          topic: topic,
          max_results: 10,
          provider: selectedProvider,
          model: selectedModel,
          // Leave custom_format undefined when empty so backend falls back
          // to the persisted user preference (huntr_config.custom_format).
          ...(customFormat.trim() ? { custom_format: customFormat.trim() } : {}),
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${resp.status}`)
      }
      if (!resp.body) throw new Error('Streaming non supporté')

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamDone = false
      const final: Partial<SearchResult> = {
        answer: '', citations: [], related_questions: [],
        search_count: 0, pro_search: proSearch, topic,
        engines: [], time_ms: 0,
      }

      try {
        while (!streamDone) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const chunk = JSON.parse(line.slice(6))
              const d = chunk.data || {}

              switch (chunk.type) {
                case 'status':
                  setStatus(d.message || '')
                  if (d.step) setCurrentStep(d.step)
                  if (d.total_steps) setTotalSteps(d.total_steps)
                  break
                case 'search':
                  final.search_count = d.count || 0
                  final.engines = d.engines || []
                  if (d.results) setLiveSources(d.results)
                  break
                case 'citation':
                  final.citations = d.citations || []
                  setResult({ ...final } as SearchResult)
                  break
                case 'chunk':
                  // Streaming token from LLM
                  final.answer += (d.token || '')
                  setResult({ ...final } as SearchResult)
                  break
                case 'content':
                  // Full answer (classic mode or fallback)
                  final.answer = d.answer || ''
                  setResult({ ...final } as SearchResult)
                  break
                case 'related':
                  final.related_questions = d.questions || []
                  setResult({ ...final } as SearchResult)
                  break
                case 'done':
                  final.time_ms = d.time_ms || 0
                  final.search_count = d.search_count || final.search_count
                  final.pro_search = d.pro_search ?? proSearch
                  final.topic = (d.topic as Topic) || topic
                  final.engines = d.engines || final.engines
                  final.model = d.model
                  final.error = d.error
                  setResult({ ...final } as SearchResult)
                  setActiveHistoryId(null)
                  refreshHistory()
                  streamDone = true
                  break
                case 'error':
                  setError(d.message || 'Erreur inconnue')
                  streamDone = true
                  break
              }
            } catch { /* skip malformed SSE */ }
          }
        }
      } finally {
        reader.cancel().catch(() => {})
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        setError(e.message)
      }
    } finally {
      setSearching(false)
      setStatus('')
    }
  }, [query, proSearch, topic, selectedProvider, selectedModel, customFormat, refreshHistory])

  const handleClear = () => {
    setResult(null)
    setQuery('')
    setError('')
    setLiveSources([])
    setCurrentStep(0)
    setTotalSteps(0)
    inputRef.current?.focus()
  }

  const loadFromHistory = (h: HistoryEntry) => {
    if (h.answer) {
      // Cached result — display directly
      setQuery(h.query)
      setError('')
      setLiveSources([])
      setSearching(false)
      setStatus('')
      setCurrentStep(0)
      setTotalSteps(0)
      setActiveHistoryId(h.id ?? null)
      setResult({
        answer: h.answer,
        citations: h.citations || [],
        related_questions: h.related_questions || [],
        search_count: h.sources_count,
        pro_search: h.mode === 'pro',
        topic: (h.topic || 'web') as Topic,
        engines: h.engines || [],
        time_ms: h.time_ms,
        model: h.model,
      })
    } else {
      // No cached answer — re-run search
      setQuery(h.query)
      doSearch(h.query)
    }
  }

  const hasResults = result || searching
  // Pro = synthèse LLM sur résultats de recherche. La recherche fallback
  // sur DDG si aucun provider payant n'est configuré, donc le vrai prérequis
  // c'est l'accès à un LLM. Les providers premium (Brave/Tavily/…) améliorent
  // la qualité mais ne conditionnent plus l'accès.
  const canPro = !!caps?.has_llm

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)',
      overflow: 'hidden',
    }}>

      {/* Header */}
      <div style={{
        padding: '12px 24px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: 'linear-gradient(135deg, var(--scarlet), var(--ember))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span>Hunt<span style={{ color: 'var(--scarlet)' }}>R</span></span>
            <span style={{
              fontSize: 10, fontFamily: 'monospace', fontWeight: 600,
              padding: '2px 6px', borderRadius: 4,
              background: 'color-mix(in srgb, var(--scarlet) 10%, transparent)',
              color: 'color-mix(in srgb, var(--scarlet) 80%, var(--text-muted))',
              border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)',
            }}>v3.6.0</span>
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
            Recherche web avec citations
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <SecondaryButton
            size="sm"
            icon={<Clock size={12} />}
            onClick={() => setShowHistory(!showHistory)}
            style={showHistory ? {
              background: 'color-mix(in srgb, var(--scarlet) 15%, transparent)',
              color: 'var(--scarlet)',
              border: '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)',
            } : undefined}
          >
            Historique
          </SecondaryButton>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', width: '100%', padding: '0 24px' }}>

            {/* Search Area */}
            <div style={{
              padding: hasResults ? '16px 0' : '0',
              ...(!hasResults ? {
                display: 'flex', flexDirection: 'column' as const,
                alignItems: 'center', justifyContent: 'center',
                minHeight: 'calc(100vh - 180px)',
              } : {}),
            }}>
              {/* Hero (idle) */}
              {!hasResults && (
                <div style={{ textAlign: 'center', marginBottom: 28 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: 14, margin: '0 auto 14px',
                    background: 'linear-gradient(135deg, var(--scarlet-light), var(--ember-light, rgba(234,88,12,0.15)))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </div>
                  <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.02em' }}>
                    Hunt<span style={{ color: 'var(--scarlet)' }}>R</span>
                  </h2>
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
                    Posez une question. Obtenez une réponse sourcée.
                  </p>

                  {/* Promo providers si aucune clé payante configurée */}
                  {caps && !caps.has_any_search_key && (
                    <div style={{
                      marginTop: 16, padding: '12px 16px', borderRadius: 10,
                      background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)',
                      fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left',
                      maxWidth: 480, margin: '16px auto 0',
                    }}>
                      <strong style={{ color: 'var(--accent-primary)' }}>Renforcez la qualité des recherches</strong>
                      <p style={{ margin: '6px 0 0', lineHeight: 1.5 }}>
                        HuntR tourne par défaut sur DuckDuckGo. Pour combiner les sources,
                        ajoutez une ou plusieurs clés gratuites :{' '}
                        <a href="https://app.tavily.com/sign-in" target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                          Tavily
                        </a>,{' '}
                        <a href="https://api.search.brave.com/" target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                          Brave
                        </a>,{' '}
                        <a href="https://exa.ai/" target="_blank" rel="noopener noreferrer"
                          style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                          Exa
                        </a>
                        {' '}(≈1000 req/mois gratuites chacun) dans{' '}
                        <a href="/settings?tab=services" style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                          Paramètres &rarr; Services
                        </a>.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Search bar */}
              <div style={{
                display: 'flex', gap: 8, width: '100%',
                maxWidth: !hasResults ? 640 : undefined,
              }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}>
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    ref={inputRef} type="text" value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && doSearch()}
                    placeholder="Posez votre question..."
                    style={{
                      width: '100%', padding: '11px 14px 11px 40px', borderRadius: 10,
                      border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                      color: 'var(--text-primary)', fontSize: 14, outline: 'none',
                    }}
                    onFocus={e => e.target.style.borderColor = 'var(--scarlet)'}
                    onBlur={e => e.target.style.borderColor = 'var(--border)'}
                  />
                </div>

                {/* Pro toggle */}
                <button
                  onClick={() => canPro && setProSearch(!proSearch)}
                  title={canPro
                    ? 'Synthèse LLM sur résultats multi-sources'
                    : 'Configurez un provider LLM (Paramètres → Providers) pour activer le mode Pro'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '11px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                    background: proSearch
                      ? 'linear-gradient(135deg, var(--amber-light, rgba(245,158,11,0.15)), var(--ember-light, rgba(234,88,12,0.1)))'
                      : 'var(--bg-secondary)',
                    border: proSearch
                      ? '1px solid var(--amber, #f59e0b)'
                      : '1px solid var(--border)',
                    color: proSearch ? 'var(--amber, #f59e0b)' : 'var(--text-muted)',
                    cursor: canPro ? 'pointer' : 'not-allowed',
                    opacity: canPro ? 1 : 0.4,
                    flexShrink: 0,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24"
                    fill={proSearch ? 'var(--amber, #f59e0b)' : 'none'}
                    stroke={proSearch ? 'var(--amber, #f59e0b)' : 'currentColor'} strokeWidth="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                  </svg>
                  Pro
                </button>

                {/* Search button */}
                <PrimaryButton
                  onClick={() => doSearch()}
                  disabled={searching || !query.trim()}
                  icon={searching
                    ? <Loader2 size={14} style={{ animation: 'huntr-spin 1s linear infinite' }} />
                    : <ArrowRight size={14} />}
                  style={{ flexShrink: 0 }}
                >
                  Rechercher
                </PrimaryButton>
              </div>

              {/* Topic segmented control + Format toggle (pro only) */}
              <div style={{
                display: 'flex', gap: 6, marginTop: 10, width: '100%',
                maxWidth: !hasResults ? 640 : undefined, flexWrap: 'wrap',
                alignItems: 'center',
              }}>
                {TOPICS.map(t => {
                  const active = topic === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTopic(t.id)}
                      title={t.desc}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '7px 12px', borderRadius: 999, fontSize: 12,
                        fontWeight: active ? 600 : 500,
                        background: active
                          ? 'linear-gradient(135deg, rgba(220,38,38,0.15), rgba(234,88,12,0.1))'
                          : 'var(--bg-secondary)',
                        border: active ? '1px solid var(--scarlet)' : '1px solid var(--border)',
                        color: active ? 'var(--scarlet)' : 'var(--text-muted)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <TopicIcon kind={t.icon} active={active} />
                      {t.label}
                    </button>
                  )
                })}
                {proSearch && (
                  <button
                    onClick={() => setShowFormatEditor(v => !v)}
                    title={customFormat
                      ? 'Format personnalisé actif — cliquer pour modifier'
                      : 'Personnaliser la structure de la réponse Pro'}
                    style={{
                      marginLeft: 'auto',
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '7px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                      background: customFormat
                        ? 'linear-gradient(135deg, rgba(220,38,38,0.15), rgba(234,88,12,0.1))'
                        : 'var(--bg-secondary)',
                      border: customFormat
                        ? '1px solid var(--scarlet)'
                        : '1px solid var(--border)',
                      color: customFormat ? 'var(--scarlet)' : 'var(--text-muted)',
                      cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    <Sliders size={12} />
                    Format
                    {customFormat && (
                      <span style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 999,
                        background: 'var(--scarlet)', color: '#fff', fontWeight: 700,
                      }}>ON</span>
                    )}
                  </button>
                )}
                {/* Sources toggle — liste les providers activables (mode Pro
                    a accès à tous, mode Classique uniquement aux gratuits) */}
                {(() => {
                  const activeCount = providersStatus.filter(p =>
                    p.enabled && p.has_requirements && (proSearch || p.supports_classic)
                  ).length
                  const showON = activeCount > 1
                  return (
                    <button
                      onClick={() => setShowProvidersPanel(v => !v)}
                      title="Choisir les moteurs de recherche actifs"
                      style={{
                        marginLeft: customFormat ? 0 : 'auto',
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '7px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                        background: showON
                          ? 'linear-gradient(135deg, rgba(220,38,38,0.15), rgba(234,88,12,0.1))'
                          : 'var(--bg-secondary)',
                        border: showON
                          ? '1px solid var(--scarlet)'
                          : '1px solid var(--border)',
                        color: showON ? 'var(--scarlet)' : 'var(--text-muted)',
                        cursor: 'pointer', transition: 'all 0.15s',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                      </svg>
                      Sources
                      <span style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 999,
                        background: showON ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                        color: showON ? '#fff' : 'var(--text-muted)',
                        fontWeight: 700,
                      }}>{activeCount}</span>
                    </button>
                  )
                })()}
              </div>

              {/* Format editor panel — WYSIWYG contenteditable */}
              {proSearch && showFormatEditor && (
                <WysiwygEditor
                  value={draftMarkdown}
                  onChange={setDraftMarkdown}
                  onSave={saveCustomFormat}
                  onReset={resetCustomFormat}
                  onClose={() => setShowFormatEditor(false)}
                  onLoadExample={loadExampleFormat}
                  saving={savingFormat}
                  flash={formatFlash}
                  isDirty={draftMarkdown.trim() !== customFormat.trim()}
                  hasSavedFormat={!!customFormat}
                  hasResults={!!hasResults}
                />
              )}

              {/* Panel Sources — toggle des moteurs de recherche */}
              {showProvidersPanel && (
                <div style={{
                  marginTop: 10,
                  padding: 14,
                  borderRadius: 10,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  width: '100%',
                  maxWidth: !hasResults ? 640 : undefined,
                }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginBottom: 10,
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                      Moteurs de recherche
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {proSearch
                        ? 'Mode Pro : tous les providers disponibles'
                        : 'Mode Classique : gratuits uniquement'}
                    </div>
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: 8,
                  }}>
                    {providersStatus.map(p => {
                      const usable = p.has_requirements && (proSearch || p.supports_classic)
                      const reason = !p.has_requirements
                        ? (p.needs_key ? 'Clé API manquante' : 'URL manquante')
                        : (!proSearch && !p.supports_classic)
                          ? 'Réservé au mode Pro'
                          : ''
                      return (
                        <label
                          key={p.id}
                          title={reason || `Poids de consensus : ${p.weight.toFixed(1)}`}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 10px', borderRadius: 8,
                            background: 'var(--bg-tertiary)',
                            border: usable && p.enabled
                              ? '1px solid var(--scarlet)'
                              : '1px solid var(--border)',
                            cursor: usable ? 'pointer' : 'not-allowed',
                            opacity: usable ? 1 : 0.5,
                            transition: 'border-color 0.15s',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={p.enabled && usable}
                            disabled={!usable || savingProviders}
                            onChange={e => toggleProvider(p.id, e.target.checked)}
                            style={{ accentColor: 'var(--scarlet)' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12, fontWeight: 600,
                              color: usable ? 'var(--text-primary)' : 'var(--text-muted)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }}>
                              {p.label}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                              {reason || (p.supports_classic ? 'Gratuit' : 'Pro uniquement')}
                            </div>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                  <div style={{
                    marginTop: 10, fontSize: 10.5, color: 'var(--text-muted)',
                    lineHeight: 1.45,
                  }}>
                    Quand plusieurs moteurs sont actifs, HuntR les lance en parallèle,
                    dédup les URLs et privilégie celles qui reviennent chez plusieurs
                    sources. Les clés API se configurent dans <strong style={{ color: 'var(--scarlet)' }}>Paramètres → Services</strong>.
                  </div>
                </div>
              )}

              {/* Suggestions (idle) */}
              {!hasResults && (
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 6, marginTop: 16, maxWidth: 640, width: '100%',
                }}>
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i}
                      onClick={() => { setQuery(s); doSearch(s) }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '9px 12px', borderRadius: 8, fontSize: 12,
                        background: 'var(--bg-secondary)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', cursor: 'pointer',
                        textAlign: 'left', transition: 'border-color 0.15s',
                      }}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--scarlet)'}
                      onMouseOut={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      </svg>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Status + progress bar */}
            {status && (
              <div style={{
                padding: '10px 14px', borderRadius: 10, margin: '6px 0',
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: totalSteps > 1 ? 8 : 0 }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: '50%',
                    border: '2px solid var(--scarlet)', borderTopColor: 'transparent',
                    animation: 'huntr-spin 0.8s linear infinite', flexShrink: 0,
                  }} />
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, flex: 1 }}>{status}</span>
                  {totalSteps > 1 && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 10, flexShrink: 0 }}>
                      {currentStep}/{totalSteps}
                    </span>
                  )}
                </div>
                {/* Progress bar (Pro mode only) */}
                {totalSteps > 1 && (
                  <div style={{ display: 'flex', gap: 3 }}>
                    {Array.from({ length: totalSteps }, (_, i) => {
                      const step = i + 1
                      const isActive = step <= currentStep
                      const isCurrent = step === currentStep
                      return (
                        <div key={step} style={{
                          flex: 1, height: 4, borderRadius: 2,
                          background: isActive ? 'var(--scarlet)' : 'var(--bg-tertiary)',
                          opacity: isCurrent ? 1 : isActive ? 0.7 : 0.3,
                          transition: 'all 0.4s ease',
                        }} />
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Live sources during search */}
            {searching && liveSources.length > 0 && !result?.answer && (
              <div style={{
                padding: 12, borderRadius: 10, margin: '6px 0',
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                  marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                  </svg>
                  Sources trouvées...
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {liveSources.slice(0, 8).map((s, i) => {
                    let host = s.url
                    try { host = new URL(s.url).hostname.replace('www.', '') } catch {}
                    return (
                      <div key={i} style={{
                        padding: '4px 8px', borderRadius: 6, fontSize: 11,
                        background: 'var(--bg-primary)', border: '1px solid var(--border)',
                        display: 'flex', alignItems: 'center', gap: 4,
                        animation: 'huntr-fadeIn 0.3s ease-out',
                        animationDelay: `${i * 0.05}s`, animationFillMode: 'both',
                      }}>
                        {/* Un point par provider qui a contribué cette URL —
                            le nombre de points signale le niveau de consensus. */}
                        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}
                             title={(s.providers || [s.source || '']).filter(Boolean).join(' + ')}>
                          {(s.providers && s.providers.length ? s.providers : [s.source || '']).map((p, j) => (
                            <div key={j} style={{
                              width: 6, height: 6, borderRadius: '50%',
                              background: ENGINE_COLORS[p || ''] || 'var(--text-muted)',
                            }} />
                          ))}
                        </div>
                        <span style={{ color: 'var(--text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {host}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div style={{
                padding: '10px 14px', borderRadius: 10, margin: '6px 0',
                background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.25)',
              }}>
                <p style={{ fontWeight: 600, fontSize: 12, color: '#ef4444', margin: '0 0 2px' }}>Erreur</p>
                <p style={{ fontSize: 12, color: '#f87171', margin: 0 }}>{error}</p>
              </div>
            )}

            {/* Results */}
            {result && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 32 }}>

                {/* Meta bar */}
                {result.time_ms > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {result.pro_search && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600,
                        background: 'var(--amber-light, rgba(245,158,11,0.15))',
                        color: 'var(--amber, #f59e0b)',
                        border: '1px solid var(--amber, #f59e0b)',
                      }}>
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                        Pro
                      </span>
                    )}
                    {result.topic && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 600,
                        background: 'rgba(220,38,38,0.1)', color: 'var(--scarlet)',
                        border: '1px solid var(--scarlet)',
                      }}>
                        <TopicIcon kind={TOPICS.find(t => t.id === result.topic)?.icon || 'globe'} active />
                        {TOPIC_LABELS[result.topic]}
                      </span>
                    )}
                    {result.engines.map(e => (
                      <span key={e} style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500,
                        background: 'var(--bg-tertiary)', color: ENGINE_COLORS[e] || 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}>
                        {e}
                      </span>
                    ))}
                    {result.model && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 20, fontSize: 10,
                        background: 'var(--bg-tertiary)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)',
                      }}>
                        {result.model}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      {result.search_count} sources &middot; {result.time_ms}ms
                    </span>
                    {result.answer && !searching && (
                      <ExportMenu query={query} result={result} />
                    )}
                  </div>
                )}

                {/* Answer card */}
                {result.answer && (
                  <div style={{
                    padding: 18, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    lineHeight: 1.7, fontSize: 14,
                  }}>
                    <MarkdownRenderer text={result.answer} citations={result.citations} onCiteClick={scrollToSource} />
                  </div>
                )}

                {/* Skeleton */}
                {searching && !result.answer && (
                  <div style={{
                    padding: 18, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    display: 'flex', flexDirection: 'column', gap: 10,
                  }}>
                    {[75, 100, 85, 60].map((w, i) => (
                      <div key={i} style={{
                        height: 12, borderRadius: 6, width: `${w}%`,
                        background: 'var(--bg-tertiary)',
                        animation: 'huntr-pulse 1.5s ease-in-out infinite',
                        animationDelay: `${i * 0.15}s`,
                      }} />
                    ))}
                  </div>
                )}

                {/* Sources */}
                {result.citations.length > 0 && (
                  <div style={{
                    padding: 14, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 600, margin: '0 0 10px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      color: 'var(--text-primary)',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
                        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
                        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
                      </svg>
                      Sources ({result.citations.length})
                    </h3>
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                      gap: 6,
                    }}>
                      {result.citations.map(c => {
                        let host = c.url
                        try { host = new URL(c.url).hostname.replace('www.', '') } catch {}
                        return (
                          <a key={c.index} id={`huntr-source-${c.index}`}
                            href={c.url} target="_blank" rel="noopener noreferrer"
                            className="huntr-source-card"
                            style={{
                              display: 'flex', gap: 8, padding: 8, borderRadius: 8,
                              background: 'var(--bg-primary)', border: '1px solid var(--border)',
                              textDecoration: 'none', color: 'inherit',
                              transition: 'border-color 0.2s, transform 0.2s, box-shadow 0.2s',
                            }}
                            onMouseOver={e => {
                              const el = e.currentTarget as HTMLElement
                              el.style.borderColor = 'var(--scarlet)'
                              el.style.transform = 'scale(1.03)'
                              el.style.boxShadow = '0 4px 12px rgba(220,38,38,0.15)'
                            }}
                            onMouseOut={e => {
                              const el = e.currentTarget as HTMLElement
                              el.style.borderColor = 'var(--border)'
                              el.style.transform = 'scale(1)'
                              el.style.boxShadow = 'none'
                            }}
                          >
                            <div style={{
                              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 10, fontWeight: 700, background: 'var(--scarlet)', color: '#fff',
                            }}>
                              {c.index}
                            </div>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{
                                fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {c.title || host}
                              </div>
                              <div style={{
                                fontSize: 10, color: 'var(--text-muted)', marginTop: 1,
                                display: 'flex', alignItems: 'center', gap: 3,
                              }}>
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                                </svg>
                                {host}
                              </div>
                            </div>
                          </a>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Related questions */}
                {result.related_questions.length > 0 && (
                  <div style={{
                    padding: 14, borderRadius: 12,
                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  }}>
                    <h3 style={{
                      fontSize: 12, fontWeight: 600, margin: '0 0 8px',
                      display: 'flex', alignItems: 'center', gap: 6,
                      color: 'var(--text-primary)',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2">
                        <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"/>
                      </svg>
                      Questions similaires
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {result.related_questions.map((q, i) => (
                        <button key={i}
                          onClick={() => { setQuery(q); doSearch(q) }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '8px 12px', borderRadius: 8, fontSize: 12,
                            background: 'var(--bg-primary)', color: 'var(--text-muted)',
                            border: '1px solid var(--border)', cursor: 'pointer',
                            textAlign: 'left', transition: 'border-color 0.15s',
                          }}
                          onMouseOver={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--scarlet)'}
                          onMouseOut={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                          </svg>
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* New search */}
                {!searching && (
                  <SecondaryButton
                    size="sm"
                    icon={<Plus size={12} />}
                    onClick={handleClear}
                    style={{ alignSelf: 'center' }}
                  >
                    Nouvelle recherche
                  </SecondaryButton>
                )}
              </div>
            )}
          </div>
        </div>

        {/* History sidebar */}
        {showHistory && (
          <div style={{
            width: 260, borderLeft: '1px solid var(--border)',
            background: 'var(--bg-secondary)', overflow: 'auto',
            padding: 10, flexShrink: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Historique</h3>
              {history.length > 0 && !favoritesOnly && (
                <button
                  onClick={async () => {
                    if (!confirm('Effacer l\'historique (hors favoris) ?')) return
                    await fetch(`${API}/history?keep_favorites=true`, { method: 'DELETE' })
                    refreshHistory()
                  }}
                  title="Effacer (conserve les favoris)"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10 }}>
                  Effacer
                </button>
              )}
            </div>

            {/* Filter tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              <button
                onClick={() => setFavoritesOnly(false)}
                style={{
                  flex: 1, padding: '4px 6px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                  background: !favoritesOnly ? 'var(--scarlet-light)' : 'var(--bg-tertiary)',
                  color: !favoritesOnly ? 'var(--scarlet)' : 'var(--text-muted)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >Tout</button>
              <button
                onClick={() => setFavoritesOnly(true)}
                style={{
                  flex: 1, padding: '4px 6px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                  background: favoritesOnly ? 'var(--scarlet-light)' : 'var(--bg-tertiary)',
                  color: favoritesOnly ? 'var(--scarlet)' : 'var(--text-muted)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                }}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                Favoris
              </button>
            </div>

            {history.length === 0 ? (
              <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {favoritesOnly ? 'Aucun favori' : 'Aucune recherche récente'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {history.map((h) => {
                  const isActive = h.id != null && h.id === activeHistoryId
                  return (
                    <div key={h.id ?? h.timestamp}
                      style={{
                        display: 'flex', alignItems: 'stretch', gap: 2,
                        borderRadius: 6,
                        background: 'var(--bg-tertiary)',
                        border: isActive ? '1px solid var(--scarlet)' : '1px solid transparent',
                        transition: 'border-color 0.15s',
                      }}
                      onMouseOver={e => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)' }}
                      onMouseOut={e => { if (!isActive) (e.currentTarget as HTMLElement).style.borderColor = 'transparent' }}
                    >
                      <button
                        onClick={() => loadFromHistory(h)}
                        style={{
                          flex: 1, padding: '7px 8px', fontSize: 11,
                          background: 'transparent', color: 'var(--text-primary)',
                          border: 'none', cursor: 'pointer',
                          textAlign: 'left', lineHeight: 1.3, minWidth: 0,
                          overflow: 'hidden',
                        }}
                      >
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {h.query}
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span>{h.sources_count} sources</span>
                          {h.mode === 'pro' && <span style={{ color: 'var(--amber, #f59e0b)' }}>Pro</span>}
                          {h.topic && h.topic !== 'web' && (
                            <span style={{ color: 'var(--scarlet)' }}>{TOPIC_LABELS[h.topic]}</span>
                          )}
                          {h.answer ? <span style={{ color: 'var(--scarlet)' }}>cache</span> : null}
                          <span>{formatTimeAgo(h.timestamp)}</span>
                        </div>
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', padding: 2, gap: 2 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFavorite(h) }}
                          title={h.is_favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            padding: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: h.is_favorite ? 'var(--amber, #f59e0b)' : 'var(--text-muted)',
                          }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24"
                            fill={h.is_favorite ? 'currentColor' : 'none'}
                            stroke="currentColor" strokeWidth="2">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                          </svg>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); if (h.id) deleteEntry(h.id) }}
                          title="Supprimer"
                          style={{
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            padding: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: 'var(--text-muted)',
                          }}
                          onMouseOver={e => (e.currentTarget as HTMLElement).style.color = '#ef4444'}
                          onMouseOut={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                            <path d="M10 11v6M14 11v6"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes huntr-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes huntr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes huntr-fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  )
}


// ── Scroll helper ─────────────────────────────────────────────────────────

function scrollToSource(idx: number) {
  const el = document.getElementById(`huntr-source-${idx}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}


// ── Citation tooltip ──────────────────────────────────────────────────────

function CitationBadge({ idx, citation, onClick }: {
  idx: number; citation?: Citation; onClick?: (idx: number) => void
}) {
  const [hover, setHover] = useState(false)
  let host = ''
  if (citation?.url) {
    try { host = new URL(citation.url).hostname.replace('www.', '') } catch {}
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button onClick={() => onClick?.(idx)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16, borderRadius: '50%', fontSize: 9, fontWeight: 700,
          background: 'var(--scarlet)', color: '#fff',
          border: 'none', cursor: 'pointer', verticalAlign: 'super', margin: '0 1px',
          transition: 'transform 0.15s',
          transform: hover ? 'scale(1.2)' : 'scale(1)',
        }}
      >
        {idx}
      </button>
      {/* Tooltip */}
      {hover && citation && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
          marginBottom: 6, width: 280, padding: '10px 12px', borderRadius: 10,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)', zIndex: 100,
          pointerEvents: 'none', animation: 'huntr-fadeIn 0.15s ease-out',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, background: 'var(--scarlet)', color: '#fff',
            }}>{idx}</div>
            <span style={{
              fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>
              {citation.title || host}
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 3 }}>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            {host}
          </div>
          {citation.snippet && (
            <p style={{
              fontSize: 11, color: 'var(--text-secondary)', margin: 0,
              lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
              {citation.snippet}
            </p>
          )}
        </div>
      )}
    </span>
  )
}


// ── Markdown Renderer with citation tooltips ──────────────────────────────

function MarkdownRenderer({ text, citations, onCiteClick }: {
  text: string; citations?: Citation[]; onCiteClick?: (idx: number) => void
}) {
  if (!text) return null

  const citationMap = new Map<number, Citation>()
  if (citations) citations.forEach(c => citationMap.set(c.index, c))

  const lines = text.split('\n')
  const elements: JSX.Element[] = []
  let key = 0

  const parse = (t: string) => inlineParse(t, key, citationMap, onCiteClick)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('### ')) {
      elements.push(<h4 key={key++} style={{ fontSize: 14, fontWeight: 700, margin: '14px 0 6px', color: 'var(--text-primary)' }}>{parse(line.slice(4))}</h4>)
    } else if (line.startsWith('## ')) {
      elements.push(<h3 key={key++} style={{ fontSize: 17, fontWeight: 700, margin: '22px 0 8px', color: 'var(--text-primary)', borderBottom: '1px solid color-mix(in srgb, var(--scarlet) 15%, transparent)', paddingBottom: 4 }}>{parse(line.slice(3))}</h3>)
    } else if (line.startsWith('# ')) {
      elements.push(<h2 key={key++} style={{ fontSize: 22, fontWeight: 800, margin: '4px 0 18px', color: 'var(--text-primary)', lineHeight: 1.3 }}>{parse(line.slice(2))}</h2>)
    } else if (/^[-*]\s/.test(line)) {
      elements.push(
        <div key={key++} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 8 }}>
          <span style={{ color: 'var(--scarlet)', flexShrink: 0 }}>&#8226;</span>
          <span style={{ color: 'var(--text-secondary)' }}>{parse(line.slice(2))}</span>
        </div>
      )
    } else if (/^\d+\.\s/.test(line)) {
      const match = line.match(/^(\d+)\.\s(.*)/)
      if (match) {
        elements.push(
          <div key={key++} style={{ display: 'flex', gap: 8, margin: '2px 0', paddingLeft: 8 }}>
            <span style={{ color: 'var(--scarlet)', flexShrink: 0, fontWeight: 600, fontSize: 12 }}>{match[1]}.</span>
            <span style={{ color: 'var(--text-secondary)' }}>{parse(match[2])}</span>
          </div>
        )
      }
    } else if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      elements.push(
        <pre key={key++} style={{
          padding: 12, borderRadius: 8, margin: '8px 0', overflow: 'auto',
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ember, #ea580c)',
        }}>
          {codeLines.join('\n')}
        </pre>
      )
    } else if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      // Markdown table : header row + separator row + body rows
      const parseCells = (row: string) => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const headerCells = parseCells(line)
      i += 2 // skip header + separator
      const bodyRows: string[][] = []
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(parseCells(lines[i]))
        i++
      }
      i-- // rewind — main loop will i++ next
      elements.push(
        <div key={key++} style={{ overflowX: 'auto', margin: '10px 0' }}>
          <table style={{
            width: '100%', borderCollapse: 'collapse', fontSize: 12,
            border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
          }}>
            <thead style={{ background: 'var(--bg-tertiary)' }}>
              <tr>
                {headerCells.map((h, hi) => (
                  <th key={hi} style={{
                    padding: '8px 10px', textAlign: 'left', fontWeight: 700,
                    color: 'var(--text-primary)', borderBottom: '1px solid var(--border)',
                  }}>{parse(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} style={{ borderTop: ri === 0 ? 'none' : '1px solid var(--border)' }}>
                  {row.map((c, ci) => (
                    <td key={ci} style={{
                      padding: '8px 10px', color: 'var(--text-secondary)',
                      verticalAlign: 'top', lineHeight: 1.5,
                    }}>{parse(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    } else if (!line.trim()) {
      elements.push(<div key={key++} style={{ height: 6 }} />)
    } else {
      elements.push(<p key={key++} style={{ margin: '6px 0', color: 'var(--text-secondary)', lineHeight: 1.7 }}>{parse(line)}</p>)
    }
  }

  return <>{elements}</>
}


function inlineParse(
  text: string, baseKey: number,
  citationMap: Map<number, Citation>,
  onCiteClick?: (idx: number) => void
): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[(\d+)\]|\[([^\]]+)\]\(([^)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let k = 0

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index))
    const key = `${baseKey}-${k++}`
    if (match[2]) {
      parts.push(<strong key={key} style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{match[2]}</strong>)
    } else if (match[3]) {
      parts.push(<em key={key} style={{ color: 'var(--text-primary)' }}>{match[3]}</em>)
    } else if (match[4]) {
      parts.push(<code key={key} style={{
        padding: '1px 5px', borderRadius: 4, fontSize: 12,
        background: 'var(--bg-tertiary)', color: 'var(--scarlet)',
        fontFamily: 'JetBrains Mono, monospace',
      }}>{match[4]}</code>)
    } else if (match[5]) {
      const idx = parseInt(match[5])
      parts.push(<CitationBadge key={key} idx={idx} citation={citationMap.get(idx)} onClick={onCiteClick} />)
    } else if (match[6] && match[7]) {
      parts.push(
        <a key={key} href={match[7]} target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--scarlet)', textDecoration: 'underline' }}>
          {match[6]}
        </a>
      )
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length > 0 ? parts : [text]
}


// ── WYSIWYG editor (contenteditable, adapte de Claude Design) ─────────────

interface WysiwygEditorProps {
  value: string                 // Markdown courant (draft)
  onChange: (md: string) => void
  onSave: (md: string) => void
  onReset: () => void
  onClose: () => void
  onLoadExample: () => void
  saving: boolean
  flash: 'ok' | 'err' | null
  isDirty: boolean
  hasSavedFormat: boolean
  hasResults: boolean
}

type FormatTag = 'p' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre'

const FORMAT_LABELS: Record<FormatTag, string> = {
  p: 'Paragraphe', h1: 'Titre 1', h2: 'Titre 2', h3: 'Titre 3',
  blockquote: 'Citation', pre: 'Code',
}

function WysiwygEditor({
  value, onChange, onSave, onReset, onClose, onLoadExample,
  saving, flash, isDirty, hasSavedFormat, hasResults,
}: WysiwygEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState<'wysiwyg' | 'markdown'>('wysiwyg')
  const [formatOpen, setFormatOpen] = useState(false)
  const [blockLabel, setBlockLabel] = useState('Paragraphe')
  const [activeMarks, setActiveMarks] = useState<Record<string, boolean>>({})
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkText, setLinkText] = useState('')
  const savedRangeRef = useRef<Range | null>(null)
  const initOnceRef = useRef(false)

  // Seed HTML from Markdown on first mount / when value changes externally
  // (mais on ne re-injecte PAS tant que l'utilisateur est en train de taper
  // pour eviter de casser le caret : on reseed seulement si l'editeur est
  // vide ou si le HTML courant ne correspond pas a la nouvelle valeur).
  useLayoutEffect(() => {
    if (mode !== 'wysiwyg') return
    const el = editorRef.current
    if (!el) return
    const currentMd = htmlToMd(el.innerHTML || '').trim()
    if (!initOnceRef.current || currentMd !== value.trim()) {
      el.innerHTML = value ? mdToHtml(value) : ''
      initOnceRef.current = true
    }
  }, [value, mode])

  // Sync textarea when switching to markdown mode
  useEffect(() => {
    if (mode === 'markdown' && textareaRef.current) {
      textareaRef.current.value = value
    }
  }, [mode, value])

  const emitChange = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    onChange(htmlToMd(el.innerHTML))
  }, [onChange])

  const updateToolbarState = useCallback(() => {
    try {
      const marks: Record<string, boolean> = {
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        strikeThrough: document.queryCommandState('strikeThrough'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
      }
      // Detect inline code
      const sel = window.getSelection()
      if (sel && sel.rangeCount) {
        let n: Node | null = sel.getRangeAt(0).startContainer
        let inCode = false, inPre = false
        while (n && n !== editorRef.current) {
          if (n.nodeType === 1) {
            const tg = (n as HTMLElement).tagName
            if (tg === 'CODE') inCode = true
            if (tg === 'PRE') inPre = true
          }
          n = n.parentNode
        }
        marks.code = inCode && !inPre
        // Current block tag
        let m: Node | null = sel.getRangeAt(0).startContainer
        let block: FormatTag = 'p'
        while (m && m !== editorRef.current) {
          if (m.nodeType === 1) {
            const tg = (m as HTMLElement).tagName
            if (tg === 'H1') { block = 'h1'; break }
            if (tg === 'H2') { block = 'h2'; break }
            if (tg === 'H3') { block = 'h3'; break }
            if (tg === 'BLOCKQUOTE') { block = 'blockquote'; break }
            if (tg === 'PRE') { block = 'pre'; break }
            if (tg === 'P') { block = 'p'; break }
          }
          m = m.parentNode
        }
        setBlockLabel(FORMAT_LABELS[block])
      }
      setActiveMarks(marks)
    } catch { /* noop */ }
  }, [])

  const exec = useCallback((cmd: string, val?: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd, false, val)
    updateToolbarState()
    emitChange()
  }, [emitChange, updateToolbarState])

  const applyBlock = useCallback((tag: FormatTag) => {
    editorRef.current?.focus()
    if (tag === 'pre') {
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      code.textContent = 'code…'
      pre.appendChild(code)
      insertNodeAtCaret(pre)
    } else {
      document.execCommand('formatBlock', false, tag)
    }
    setFormatOpen(false)
    updateToolbarState()
    emitChange()
  }, [emitChange, updateToolbarState])

  const insertNodeAtCaret = (node: Node) => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) {
      el.appendChild(node)
    } else {
      const r = sel.getRangeAt(0)
      r.deleteContents()
      r.insertNode(node)
      r.setStartAfter(node)
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
    }
  }

  const insertTable = () => {
    const tbl = document.createElement('table')
    tbl.innerHTML = `
      <thead><tr><th>Colonne 1</th><th>Colonne 2</th><th>Colonne 3</th></tr></thead>
      <tbody>
        <tr><td>…</td><td>…</td><td>…</td></tr>
        <tr><td>…</td><td>…</td><td>…</td></tr>
      </tbody>`
    insertNodeAtCaret(tbl)
    emitChange()
  }

  // Insere un chip {{TITRE}} a la position du caret. A la sauvegarde,
  // le chip est serialise en `{{TITRE}}` dans le Markdown ; cote backend,
  // le LLM remplace ce marqueur par un titre d'une phrase reformulant la
  // question de recherche.
  const insertTitleVariable = () => {
    editorRef.current?.focus()
    const chip = document.createElement('span')
    chip.className = 'huntr-variable'
    chip.setAttribute('data-var', 'TITRE')
    chip.setAttribute('contenteditable', 'false')
    chip.textContent = 'Titre dynamique'
    insertNodeAtCaret(chip)
    // Ajoute un espace insecable apres pour que le caret puisse sortir du chip.
    const sp = document.createTextNode('\u00A0')
    const sel = window.getSelection()
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0)
      r.insertNode(sp)
      r.setStartAfter(sp); r.collapse(true)
      sel.removeAllRanges(); sel.addRange(r)
    }
    emitChange()
  }

  const wrapInline = (tag: string) => {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return
    const r = sel.getRangeAt(0)
    const el = document.createElement(tag)
    try {
      el.appendChild(r.extractContents())
      r.insertNode(el)
      sel.removeAllRanges()
      const nr = document.createRange()
      nr.selectNodeContents(el)
      sel.addRange(nr)
    } catch { /* noop */ }
    updateToolbarState()
    emitChange()
  }

  const openLink = () => {
    const sel = window.getSelection()
    savedRangeRef.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null
    setLinkUrl('')
    setLinkText(savedRangeRef.current ? savedRangeRef.current.toString() : '')
    setLinkOpen(true)
  }
  const applyLink = () => {
    if (!linkUrl.trim()) { setLinkOpen(false); return }
    editorRef.current?.focus()
    const sel = window.getSelection()
    if (sel && savedRangeRef.current) { sel.removeAllRanges(); sel.addRange(savedRangeRef.current) }
    const a = document.createElement('a')
    a.href = linkUrl.trim()
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = linkText.trim() || linkUrl.trim()
    if (savedRangeRef.current && !savedRangeRef.current.collapsed) {
      savedRangeRef.current.deleteContents()
      savedRangeRef.current.insertNode(a)
    } else {
      insertNodeAtCaret(a)
    }
    setLinkOpen(false)
    emitChange()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const m = e.metaKey || e.ctrlKey
    if (m && e.altKey) {
      if (e.key === '0') { e.preventDefault(); applyBlock('p') }
      else if (e.key === '1') { e.preventDefault(); applyBlock('h1') }
      else if (e.key === '2') { e.preventDefault(); applyBlock('h2') }
      else if (e.key === '3') { e.preventDefault(); applyBlock('h3') }
    } else if (m && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault(); openLink()
    }
  }

  const tbBtn = (active: boolean) => ({
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 5, border: 'none', cursor: 'pointer' as const,
    background: active ? 'color-mix(in srgb, var(--scarlet) 18%, transparent)' : 'transparent',
    color: active ? 'var(--scarlet)' : 'var(--text-secondary)',
    position: 'relative' as const, transition: 'all 0.1s',
  })

  const tbGroup: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 1, padding: '0 4px',
    borderRight: '1px solid var(--border)',
  }

  return (
    <div style={{
      marginTop: 10, width: '100%',
      maxWidth: !hasResults ? 780 : undefined,
      borderRadius: 10, background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
      overflow: 'hidden',
    }}>
      <style>{`
        .huntr-wysiwyg {
          padding: 20px 24px 28px;
          min-height: 280px;
          max-height: 520px;
          overflow-y: auto;
          font-size: 14px;
          line-height: 1.65;
          color: var(--text-primary);
          outline: none;
          background: var(--bg-primary);
        }
        .huntr-wysiwyg:empty::before {
          content: attr(data-placeholder);
          color: var(--text-muted);
          pointer-events: none;
        }
        .huntr-wysiwyg h1, .huntr-wysiwyg h2, .huntr-wysiwyg h3 {
          font-weight: 700; color: var(--text-primary);
          margin: 1.2em 0 0.4em; line-height: 1.25; letter-spacing: -0.01em;
        }
        .huntr-wysiwyg h1 { font-size: 24px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
        .huntr-wysiwyg h2 { font-size: 19px; color: var(--scarlet); }
        .huntr-wysiwyg h3 { font-size: 16px; }
        .huntr-wysiwyg p { margin: 0.5em 0; }
        .huntr-wysiwyg a {
          color: var(--scarlet); text-decoration: underline;
          text-decoration-color: color-mix(in srgb, var(--scarlet) 40%, transparent);
          text-underline-offset: 3px;
        }
        .huntr-wysiwyg ul, .huntr-wysiwyg ol { padding-left: 22px; margin: 0.5em 0; }
        .huntr-wysiwyg li { margin: 2px 0; }
        .huntr-wysiwyg blockquote {
          margin: 0.8em 0; padding: 8px 14px;
          border-left: 3px solid var(--scarlet);
          background: color-mix(in srgb, var(--scarlet) 6%, transparent);
          border-radius: 0 6px 6px 0;
          color: var(--text-secondary); font-style: italic;
        }
        .huntr-wysiwyg code {
          font-family: 'JetBrains Mono', monospace; font-size: 0.88em;
          background: color-mix(in srgb, var(--scarlet) 10%, transparent);
          color: var(--scarlet);
          padding: 1px 5px; border-radius: 3px;
          border: 1px solid color-mix(in srgb, var(--scarlet) 18%, transparent);
        }
        .huntr-wysiwyg pre {
          font-family: 'JetBrains Mono', monospace; font-size: 12px;
          background: var(--bg-tertiary); border: 1px solid var(--border);
          border-radius: 6px; padding: 10px 12px; margin: 0.8em 0;
          overflow-x: auto; color: var(--text-secondary);
        }
        .huntr-wysiwyg pre code { background: none; border: none; padding: 0; color: inherit; }
        .huntr-wysiwyg table { border-collapse: collapse; margin: 0.8em 0; width: 100%; font-size: 12.5px; }
        .huntr-wysiwyg th, .huntr-wysiwyg td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
        .huntr-wysiwyg th {
          background: var(--bg-tertiary); color: var(--text-primary); font-weight: 700;
          font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase;
        }
        .huntr-wysiwyg td { color: var(--text-secondary); }
        .huntr-wysiwyg hr { border: none; border-top: 1px solid var(--border); margin: 1.3em 0; }
        .huntr-wysiwyg:focus-visible { outline: 1px solid var(--scarlet); outline-offset: -1px; }

        .huntr-wysiwyg .huntr-variable {
          display: inline-flex; align-items: center; gap: 4px;
          vertical-align: baseline;
          padding: 1px 9px 2px;
          background: color-mix(in srgb, var(--scarlet) 16%, transparent);
          color: var(--scarlet);
          border: 1px solid color-mix(in srgb, var(--scarlet) 38%, transparent);
          border-radius: 999px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.78em; font-weight: 700;
          letter-spacing: 0.3px; text-transform: uppercase;
          user-select: all; cursor: default;
          white-space: nowrap;
        }
        .huntr-wysiwyg .huntr-variable::before {
          content: '✦'; font-size: 10px; opacity: 0.9;
        }
        .huntr-wysiwyg h1 .huntr-variable,
        .huntr-wysiwyg h2 .huntr-variable,
        .huntr-wysiwyg h3 .huntr-variable {
          font-size: 0.56em;
          padding: 2px 10px 3px;
        }

        .huntr-tb-btn:hover { background: var(--bg-tertiary) !important; color: var(--text-primary) !important; }
      `}</style>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Sliders size={13} style={{ color: 'var(--scarlet)' }} />
          Modèle de réponse — WYSIWYG
          {isDirty && (
            <span style={{
              fontSize: 9, padding: '1px 6px', borderRadius: 999,
              background: 'color-mix(in srgb, var(--scarlet) 18%, transparent)',
              color: 'var(--scarlet)', fontWeight: 700, letterSpacing: 0.3,
            }}>MODIFIÉ</span>
          )}
        </div>
        <button onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
          title="Réduire">
          <X size={14} />
        </button>
      </div>

      {/* Toolbar */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2,
        padding: '6px 8px', background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border)',
      }}>
        {/* Block format dropdown */}
        <div style={tbGroup}>
          <div style={{ position: 'relative' }}>
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={e => { e.stopPropagation(); setFormatOpen(v => !v) }}
              style={{
                height: 28, padding: '0 10px', fontSize: 11.5, gap: 6,
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: 5, color: 'var(--text-secondary)',
                cursor: 'pointer', display: 'flex', alignItems: 'center',
              }}
            >
              {blockLabel}
              <ChevronDown size={11} />
            </button>
            {formatOpen && (
              <>
                <div onClick={() => setFormatOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 19 }} />
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 7, boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
                  minWidth: 180, padding: 4, zIndex: 20,
                }}>
                  {([
                    ['p', 'Paragraphe', { fontSize: 12 }],
                    ['h1', 'Titre 1', { fontSize: 16, fontWeight: 700 }],
                    ['h2', 'Titre 2', { fontSize: 14, fontWeight: 700, color: 'var(--scarlet)' }],
                    ['h3', 'Titre 3', { fontSize: 13, fontWeight: 600 }],
                    ['blockquote', 'Citation', { fontSize: 12, fontStyle: 'italic' as const, paddingLeft: 6, borderLeft: '2px solid var(--scarlet)' }],
                    ['pre', 'Bloc de code', { fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: 'var(--scarlet)' }],
                  ] as [FormatTag, string, React.CSSProperties][]).map(([tag, label, st]) => (
                    <button key={tag}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => applyBlock(tag)}
                      style={{
                        display: 'block', width: '100%', padding: '7px 10px',
                        borderRadius: 4, color: 'var(--text-primary)', background: 'transparent',
                        border: 'none', cursor: 'pointer', textAlign: 'left', ...st,
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >{label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Marks */}
        <div style={tbGroup}>
          <button className="huntr-tb-btn" title="Gras (⌘B)" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('bold')} style={tbBtn(!!activeMarks.bold)}><Bold size={13} /></button>
          <button className="huntr-tb-btn" title="Italique (⌘I)" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('italic')} style={tbBtn(!!activeMarks.italic)}><Italic size={13} /></button>
          <button className="huntr-tb-btn" title="Souligné (⌘U)" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('underline')} style={tbBtn(!!activeMarks.underline)}><Underline size={13} /></button>
          <button className="huntr-tb-btn" title="Barré" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('strikeThrough')} style={tbBtn(!!activeMarks.strikeThrough)}><Strikethrough size={13} /></button>
          <button className="huntr-tb-btn" title="Code inline" onMouseDown={e => e.preventDefault()}
            onClick={() => wrapInline('code')} style={tbBtn(!!activeMarks.code)}><Code size={13} /></button>
        </div>

        {/* Lists */}
        <div style={tbGroup}>
          <button className="huntr-tb-btn" title="Liste à puces" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('insertUnorderedList')} style={tbBtn(!!activeMarks.insertUnorderedList)}><List size={13} /></button>
          <button className="huntr-tb-btn" title="Liste numérotée" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('insertOrderedList')} style={tbBtn(!!activeMarks.insertOrderedList)}><ListOrdered size={13} /></button>
          <button className="huntr-tb-btn" title="Citation" onMouseDown={e => e.preventDefault()}
            onClick={() => applyBlock('blockquote')} style={tbBtn(blockLabel === 'Citation')}><Quote size={13} /></button>
        </div>

        {/* Insert */}
        <div style={tbGroup}>
          <button className="huntr-tb-btn"
            title="Titre dynamique — lié au résultat de recherche (insère {{TITRE}})"
            onMouseDown={e => e.preventDefault()}
            onClick={insertTitleVariable}
            style={{
              ...tbBtn(false),
              width: 'auto', padding: '0 8px', gap: 4,
              color: 'var(--scarlet)', fontSize: 10.5, fontWeight: 700,
              letterSpacing: 0.3, textTransform: 'uppercase' as const,
              display: 'flex', alignItems: 'center',
            }}>
            <Sparkles size={12} /> Titre
          </button>
          <button className="huntr-tb-btn" title="Lien (⌘K)" onMouseDown={e => e.preventDefault()}
            onClick={openLink} style={tbBtn(false)}><Link2 size={13} /></button>
          <button className="huntr-tb-btn" title="Tableau" onMouseDown={e => e.preventDefault()}
            onClick={insertTable} style={tbBtn(false)}><TableIcon size={13} /></button>
          <button className="huntr-tb-btn" title="Séparateur" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('insertHorizontalRule')} style={tbBtn(false)}><Minus size={13} /></button>
        </div>

        {/* History */}
        <div style={tbGroup}>
          <button className="huntr-tb-btn" title="Annuler (⌘Z)" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('undo')} style={tbBtn(false)}><Undo2 size={13} /></button>
          <button className="huntr-tb-btn" title="Rétablir (⌘⇧Z)" onMouseDown={e => e.preventDefault()}
            onClick={() => exec('redo')} style={tbBtn(false)}><Redo2 size={13} /></button>
        </div>

        <div style={{ flex: 1 }} />

        {/* Mode toggle */}
        <div style={{
          display: 'flex', background: 'var(--bg-primary)',
          border: '1px solid var(--border)', borderRadius: 5, padding: 2,
        }}>
          {(['wysiwyg', 'markdown'] as const).map(m => {
            const active = mode === m
            return (
              <button key={m}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  if (m === 'markdown' && mode === 'wysiwyg') {
                    // Passer en md : serialize current html
                    emitChange()
                  } else if (m === 'wysiwyg' && mode === 'markdown' && textareaRef.current) {
                    const md = textareaRef.current.value
                    onChange(md)
                  }
                  setMode(m)
                }}
                style={{
                  padding: '3px 10px', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10, fontWeight: 600, letterSpacing: 0.5,
                  color: active ? 'var(--scarlet)' : 'var(--text-muted)',
                  background: active ? 'var(--bg-tertiary)' : 'transparent',
                  border: 'none', borderRadius: 3, cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >{m === 'wysiwyg' ? 'WYSIWYG' : 'Markdown'}</button>
            )
          })}
        </div>
      </div>

      {/* Editor area */}
      <div style={{ position: 'relative' }}>
        {mode === 'wysiwyg' ? (
          <div
            ref={editorRef}
            className="huntr-wysiwyg"
            contentEditable
            data-placeholder="Compose ton modèle de réponse : titres figés + paragraphes/listes/tableaux dont le LLM remplira le contenu. Cite les sources avec [1], [2]…"
            suppressContentEditableWarning
            onInput={emitChange}
            onKeyUp={updateToolbarState}
            onMouseUp={updateToolbarState}
            onKeyDown={handleKeyDown}
            onBlur={emitChange}
          />
        ) : (
          <textarea
            ref={textareaRef}
            defaultValue={value}
            onChange={e => onChange(e.target.value)}
            spellCheck={false}
            style={{
              display: 'block', width: '100%',
              padding: '16px 20px', minHeight: 280, maxHeight: 520,
              background: 'var(--bg-primary)', color: 'var(--text-secondary)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5, lineHeight: 1.6,
              border: 'none', outline: 'none', resize: 'vertical',
              whiteSpace: 'pre-wrap',
            }}
          />
        )}
      </div>

      {/* Footer actions */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 14px', borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        <PrimaryButton
          onClick={() => onSave(value)}
          disabled={saving || !isDirty}
          icon={saving ? <Loader2 size={12} style={{ animation: 'huntr-spin 1s linear infinite' }} /> : <Save size={12} />}
        >
          {flash === 'ok' ? 'Sauvegardé' : 'Appliquer'}
        </PrimaryButton>
        <SecondaryButton onClick={onLoadExample} disabled={saving}>
          Charger exemple
        </SecondaryButton>
        {hasSavedFormat && (
          <SecondaryButton onClick={onReset} disabled={saving}>
            Réinitialiser
          </SecondaryButton>
        )}
        <SecondaryButton onClick={onClose}>Réduire</SecondaryButton>
        {flash === 'err' && (
          <span style={{ fontSize: 11, color: 'var(--accent-danger, #dc2626)' }}>Échec sauvegarde</span>
        )}
        <span style={{
          marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace', letterSpacing: 0.3,
        }}>
          {value.trim() ? `${value.trim().split(/\s+/).length} mots · Markdown` : 'vide'}
        </span>
      </div>

      {/* Link modal */}
      {linkOpen && (
        <div onClick={e => { if (e.target === e.currentTarget) setLinkOpen(false) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, backdropFilter: 'blur(2px)',
          }}>
          <div style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 10, padding: 18, width: 420,
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--scarlet)', fontWeight: 700 }}>
              Ajouter un lien
            </h3>
            <input type="text" value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
              placeholder="https://…" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') applyLink() }}
              style={{
                width: '100%', padding: '8px 12px', marginBottom: 8,
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, outline: 'none',
              }} />
            <input type="text" value={linkText} onChange={e => setLinkText(e.target.value)}
              placeholder="Texte du lien (optionnel)"
              style={{
                width: '100%', padding: '8px 12px',
                background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, outline: 'none',
              }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <SecondaryButton onClick={() => setLinkOpen(false)}>Annuler</SecondaryButton>
              <PrimaryButton onClick={applyLink}>Insérer</PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

