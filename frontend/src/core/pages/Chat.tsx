import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { useStore } from '../stores/appStore'
import { api, apiFetch } from '../services/api'
import {
  Send, Plus, User, Mic, MicOff, ChevronDown, Bot,
  Search, Sparkles, MessageSquare, Star,
  Code, FileText, Globe, BarChart3, Radio,
  ChevronLeft, ChevronRight, Pencil, Check, X, Key,
  Paperclip, Image as ImageIcon, Copy, Folder, FolderMinus, GripVertical,
  Calendar, Play, Pause, CheckCircle2, AlertCircle, Clock,
  RefreshCw, ThumbsUp, ThumbsDown, Zap, Wand2, Volume2, VolumeX, Loader2,
  ShieldCheck, ShieldAlert, Square, Pin
} from 'lucide-react'
import { SecondaryButton } from '../components/ui'
import VoiceModal from '../components/VoiceModal'
import ApiKeysModal from '../components/ApiKeysModal'
import UserModal from '../components/UserModal'
import ConversationMenu from '../components/ConversationMenu'

function AgentAvatar({ size = 32 }: { size?: number }) {
  return (
    <img src="/logo.png" alt="Agent" width={size} height={size}
      className="rounded-full flex-shrink-0 object-contain" />
  )
}

function AgentIcon({ size = 16 }: { size?: number }) {
  return <img src="/logo.png" alt="Agent" width={size} height={size} className="object-contain" />
}

// Bouton de copie réutilisable (message entier ou bloc de code)
function CopyButton({ text, label, compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API indisponible — ignorer silencieusement
    }
  }
  return (
    <button
      onClick={handleCopy}
      className={`flex items-center gap-1 rounded-md transition-all ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'}`}
      style={{
        background: copied ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'var(--bg-secondary)',
        color: copied ? 'var(--accent-success)' : 'var(--text-muted)',
        border: `1px solid ${copied ? 'color-mix(in srgb, var(--accent-success) 30%, transparent)' : 'var(--border)'}`,
      }}
      title={copied ? 'Copié !' : 'Copier'}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {label && <span>{copied ? 'Copié' : label}</span>}
    </button>
  )
}

// Barre d'actions sous chaque message (copie, etc.) — toujours visible, style Claude
// Icône de copie flottante — sticky en haut de la bulle, apparait au survol
// Le wrapper sticky (h-0) reste collé en haut du scroll container tant que la bulle
// est visible, donc le bouton reste accessible même sur un message très long.
function FloatingCopyButton({ content, side = 'right' }: { content: string; side?: 'left' | 'right' }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="sticky top-2 h-0 z-10 pointer-events-none">
      <button
        onClick={handleCopy}
        className={`pointer-events-auto absolute -top-1 ${side === 'right' ? 'right-0' : 'left-0'} p-1.5 rounded-md transition-all opacity-0 group-hover:opacity-100 hover:scale-110`}
        style={{
          background: copied
            ? 'color-mix(in srgb, var(--accent-success) 25%, var(--bg-primary))'
            : 'color-mix(in srgb, var(--scarlet) 20%, var(--bg-primary))',
          color: copied ? 'var(--accent-success)' : 'var(--accent-primary-light, #ff6b6b)',
          border: `1px solid ${copied ? 'color-mix(in srgb, var(--accent-success) 50%, transparent)' : 'color-mix(in srgb, var(--scarlet) 45%, transparent)'}`,
          backdropFilter: 'blur(6px)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
        title={copied ? 'Copié !' : 'Copier le message'}
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

// Pastille tokens — affichée dans l'en-tête de la bulle, côté opposé au pseudo.
function TokenBadge({ tokens }: { tokens: number }) {
  return (
    <span
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
      style={{
        color: 'var(--text-muted)',
        background: 'color-mix(in srgb, var(--accent-tertiary, var(--scarlet)) 6%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent-tertiary, var(--scarlet)) 15%, transparent)',
      }}
      title={`${tokens} tokens`}
    >
      <Zap className="w-2.5 h-2.5" />
      <span>{tokens > 999 ? `${(tokens / 1000).toFixed(1)}K` : tokens}</span>
    </span>
  )
}

// Barre d'actions sous chaque bulle : copie + (assistant) régénération + 👍/👎
// Les scores 👍/👎 sont envoyés au plugin Conscience pour auto-évaluer la pertinence des réponses.
function MessageActions({
  role,
  content,
  onRegenerate,
  canRegenerate,
  onScore,
}: {
  role: 'user' | 'assistant'
  content: string
  onRegenerate?: () => void
  canRegenerate?: boolean
  onScore?: (value: 'up' | 'down') => void
}) {
  const [copied, setCopied] = useState(false)
  const [scored, setScored] = useState<null | 'up' | 'down'>(null)
  const [scoreBusy, setScoreBusy] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }
  const handleScore = async (val: 'up' | 'down') => {
    if (!onScore || scoreBusy) return
    setScoreBusy(true)
    try { await onScore(val); setScored(val) }
    finally { setScoreBusy(false) }
  }

  const baseBtn = 'flex items-center justify-center rounded-md transition-all hover:opacity-100 opacity-70'
  const btnStyle = {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid var(--border-subtle)',
    width: 24,
    height: 24,
  } as React.CSSProperties

  return (
    <div className={`flex items-center gap-1.5 mt-1 ${role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
      <button
        onClick={handleCopy}
        className={baseBtn}
        style={{ ...btnStyle, color: copied ? 'var(--accent-success)' : 'var(--text-muted)' }}
        title={copied ? 'Copié !' : 'Copier'}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
      {role === 'assistant' && canRegenerate && onRegenerate && (
        <button
          onClick={onRegenerate}
          className={baseBtn}
          style={btnStyle}
          title="Régénérer la réponse"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      )}
      {role === 'assistant' && onScore && (
        <>
          <button
            onClick={() => handleScore('up')}
            disabled={scoreBusy}
            className={baseBtn}
            style={{
              ...btnStyle,
              color: scored === 'up' ? 'var(--accent-success)' : 'var(--text-muted)',
              background: scored === 'up' ? 'color-mix(in srgb, var(--accent-success) 15%, transparent)' : 'transparent',
            }}
            title="Réponse pertinente"
          >
            <ThumbsUp className="w-3 h-3" />
          </button>
          <button
            onClick={() => handleScore('down')}
            disabled={scoreBusy}
            className={baseBtn}
            style={{
              ...btnStyle,
              color: scored === 'down' ? 'var(--accent-primary)' : 'var(--text-muted)',
              background: scored === 'down' ? 'color-mix(in srgb, var(--scarlet) 15%, transparent)' : 'transparent',
            }}
            title="Réponse hors-sujet"
          >
            <ThumbsDown className="w-3 h-3" />
          </button>
        </>
      )}
    </div>
  )
}

// Bloc de code avec entête (langage + copie) et zone monospace scrollable
function CodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="my-2 rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)', background: '#0b0b0d' }}>
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-widest"
        style={{ background: 'color-mix(in srgb, var(--scarlet) 8%, #151518)', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
        <span className="font-semibold" style={{ color: 'var(--accent-primary-light, var(--accent-primary))' }}>
          {language || 'code'}
        </span>
        <CopyButton text={code} label="Copier" compact />
      </div>
      <pre className="p-3 text-xs overflow-x-auto leading-relaxed" style={{ color: '#e6e6e6', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

// ── Inline markdown rendering ────────────────────────────────────────
// Supports: **bold**, *italic* / _italic_, `code`, [label](url)
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
        <code key={key++} className="px-1 py-0.5 rounded text-[0.85em] font-mono"
          style={{ background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)', color: 'var(--accent-primary-light, var(--accent-primary))', border: '1px solid color-mix(in srgb, var(--scarlet) 15%, transparent)' }}>
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

// ── Block markdown rendering (headings, lists, quotes, tables, paragraphs) ──
function renderMarkdownBlock(text: string, keyPrefix: string): React.ReactNode {
  const lines = text.split('\n')
  const nodes: React.ReactNode[] = []
  let i = 0
  let k = 0
  const pushKey = () => `${keyPrefix}-${k++}`

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') { i++; continue }

    // Headings
    const h = /^(#{1,3})\s+(.+)$/.exec(trimmed)
    if (h) {
      const level = h[1].length
      const inner = renderInline(h[2])
      if (level === 1) {
        nodes.push(<h1 key={pushKey()} style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.3, margin: '18px 0 10px', color: 'var(--text-primary)' }}>{inner}</h1>)
      } else if (level === 2) {
        nodes.push(<h2 key={pushKey()} style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.35, margin: '16px 0 8px', paddingBottom: 4, borderBottom: '1px solid color-mix(in srgb, var(--scarlet) 25%, transparent)', color: 'var(--text-primary)' }}>{inner}</h2>)
      } else {
        nodes.push(<h3 key={pushKey()} style={{ fontSize: 15, fontWeight: 700, margin: '14px 0 6px', color: 'var(--text-primary)' }}>{inner}</h3>)
      }
      i++; continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const qLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      nodes.push(
        <blockquote key={pushKey()} style={{ margin: '8px 0', padding: '6px 12px', borderLeft: '3px solid var(--scarlet)', background: 'color-mix(in srgb, var(--scarlet) 6%, transparent)', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          {renderInline(qLines.join(' '))}
        </blockquote>
      )
      continue
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''))
        i++
      }
      nodes.push(
        <ul key={pushKey()} style={{ margin: '6px 0', paddingLeft: 22, listStyle: 'disc' }}>
          {items.map((it, j) => <li key={j} style={{ margin: '3px 0', lineHeight: 1.65 }}>{renderInline(it)}</li>)}
        </ul>
      )
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      nodes.push(
        <ol key={pushKey()} style={{ margin: '6px 0', paddingLeft: 22, listStyle: 'decimal' }}>
          {items.map((it, j) => <li key={j} style={{ margin: '3px 0', lineHeight: 1.65 }}>{renderInline(it)}</li>)}
        </ol>
      )
      continue
    }

    // Table (| a | b | separator row | --- | --- |)
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1].trim())) {
      const header = trimmed.replace(/^\||\|$/g, '').split('|').map(s => s.trim())
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim()))
        i++
      }
      nodes.push(
        <div key={pushKey()} style={{ overflowX: 'auto', margin: '10px 0' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.92em' }}>
            <thead>
              <tr>{header.map((h2, j) => <th key={j} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '2px solid var(--scarlet)', color: 'var(--text-primary)', fontWeight: 700 }}>{renderInline(h2)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  {row.map((c, ci) => <td key={ci} style={{ padding: '6px 10px', verticalAlign: 'top' }}>{renderInline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Paragraph: consume consecutive non-empty, non-special lines
    const pLines: string[] = []
    while (i < lines.length) {
      const l = lines[i]
      const lt = l.trim()
      if (lt === '') break
      if (/^(#{1,3})\s+/.test(lt)) break
      if (lt.startsWith('>')) break
      if (/^[-*]\s+/.test(lt)) break
      if (/^\d+\.\s+/.test(lt)) break
      if (lt.startsWith('|')) break
      pLines.push(l)
      i++
    }
    if (pLines.length > 0) {
      nodes.push(
        <p key={pushKey()} style={{ margin: '6px 0', lineHeight: 1.7 }}>
          {renderInline(pLines.join('\n'))}
        </p>
      )
    }
  }

  return <>{nodes}</>
}

// Rendu d'un message : parse les fences ```lang ... ```, alterne blocs markdown / CodeBlock
function MessageContent({ content }: { content: string }) {
  const parts: Array<{ type: 'md' | 'code'; content: string; language?: string }> = []
  const regex = /```(\w+)?\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'md', content: content.slice(lastIndex, match.index) })
    }
    parts.push({ type: 'code', content: match[2].replace(/\n$/, ''), language: match[1] })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'md', content: content.slice(lastIndex) })
  }
  if (parts.length === 0) {
    parts.push({ type: 'md', content })
  }

  return (
    <div className="markdown-body" style={{ color: 'var(--text-primary)' }}>
      {parts.map((part, i) =>
        part.type === 'code'
          ? <CodeBlock key={i} code={part.content} language={part.language} />
          : <div key={i}>{renderMarkdownBlock(part.content, `b${i}`)}</div>
      )}
    </div>
  )
}

// Fullscreen image preview overlay. Click-anywhere (ou touche Échap) pour
// fermer. Stop propagation sur l'image elle-même pour laisser la zoomée
// sans fermer accidentellement.
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, cursor: 'zoom-out',
      }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{
          position: 'absolute', top: 16, right: 16,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
        title="Fermer (Échap)"
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={src}
        alt="Aperçu plein écran"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '95vw', maxHeight: '95vh',
          objectFit: 'contain',
          borderRadius: 6,
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          cursor: 'default',
        }}
      />
    </div>
  )
}

export default function Chat() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    config, agentName,
    messages, currentConversation, setCurrentConversation,
    conversations, setConversations, isLoading, setLoading,
    loadingConvoId, setLoadingConvoId,
    selectedProvider, setSelectedProvider, selectedModel, setSelectedModel,
    setMessages, addMessage,
    activePersonality, setActivePersonality
  } = useStore()

  const [input, setInput] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [personalities, setPersonalities] = useState<any[]>([])

  // Automata tab — "chats" = normal conversations, "automata" = scheduled task history
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'automata'>('chats')
  const [automataTasks, setAutomataTasks] = useState<any[]>([])
  const [activeAutomataTaskId, setActiveAutomataTaskId] = useState<string | null>(null)
  const [automataHistory, setAutomataHistory] = useState<any[]>([])
  const [showPersonaMenu, setShowPersonaMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [stats, setStats] = useState({ tokens: 0, messages: 0, cost: 0 })
  const [providerModelsMap, setProviderModelsMap] = useState<Record<string, string[]>>({})
  const [modelSearch, setModelSearch] = useState('')
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  // Favoris modèles (max 5, partagé via localStorage)
  const [favoriteModels, setFavoriteModels] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('gungnir_favorite_models') || '[]') } catch { return [] }
  })
  const toggleFavorite = (provider: string, model: string) => {
    const key = `${provider}::${model}`
    setFavoriteModels(prev => {
      const next = prev.includes(key) ? prev.filter(f => f !== key) : prev.length >= 5 ? prev : [...prev, key]
      localStorage.setItem('gungnir_favorite_models', JSON.stringify(next))
      return next
    })
  }

  // Skills
  const [allSkills, setAllSkills] = useState<any[]>([])
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  const [favoriteSkills, setFavoriteSkills] = useState<any[]>([])
  const [showSkillsBar, setShowSkillsBar] = useState(false)

  // Welcome onboarding
  const [onboardingState, setOnboardingState] = useState<{
    step: 'pending' | 'in_progress' | 'done'
    has_api_key: boolean
    welcome_convo_id: number | null
    agent_name: string
  } | null>(null)
  const onboardingAutoOpenedRef = useRef(false)

  // File/image attachments
  const [attachedFiles, setAttachedFiles] = useState<{ name: string; type: string; dataUrl: string; preview?: string }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const dragCounterRef = useRef(0)

  const ACCEPTED_EXTENSIONS = ['txt','md','json','csv','xml','html','py','js','ts','tsx','jsx','css','yaml','yml','log','sql','sh','bat']

  const isAcceptedFile = (file: File) => {
    if (file.type.startsWith('image/')) return true
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    return ACCEPTED_EXTENSIONS.includes(ext)
  }

  const processFiles = (files: FileList | File[]) => {
    Array.from(files).forEach(file => {
      if (!isAcceptedFile(file)) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setAttachedFiles(prev => [...prev, {
          name: file.name,
          type: file.type,
          dataUrl,
          preview: file.type.startsWith('image/') ? dataUrl : undefined,
        }])
      }
      reader.readAsDataURL(file)
    })
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    processFiles(files)
    e.target.value = ''
  }

  const hasFiles = (e: React.DragEvent) => {
    const types = e.dataTransfer?.types
    if (!types) return false
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true
    }
    return false
  }

  const handleDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    setIsDraggingFiles(true)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setIsDraggingFiles(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingFiles(false)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) processFiles(files)
  }

  const removeAttachment = (idx: number) => setAttachedFiles(prev => prev.filter((_, i) => i !== idx))

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // AbortController pour interrompre le stream LLM en cours (bouton Stop ou
  // renvoi d'un nouveau message pendant la génération).
  const abortRef = useRef<AbortController | null>(null)
  // Message user qu'on garde en mémoire quand on interrompt pour le
  // rajouter au contexte du prochain envoi.
  const pendingContextRef = useRef<string | null>(null)
  // Message texte "en file d'attente" : quand l'utilisateur envoie pendant
  // la génération, on stocke son nouveau texte ici puis on abort. Dès que
  // le handler en cours se termine, un useEffect rejoue handleSend avec
  // ce texte (enrichi du contexte du message interrompu).
  const queuedSendRef = useRef<string | null>(null)
  // Image affichée en fullscreen (lightbox). null = overlay caché.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  // When we create a conversation locally (handleSend / handleNewChat /
  // handleNewChatWithSummary), we already know its messages state — either
  // empty or the optimistic user message we just added. Without this ref,
  // the useEffect on currentConversation would race and wipe that state by
  // calling loadMessages() before the backend has persisted the user msg.
  // Carry the expected ID so a no-op setCurrentConversation can't leave a
  // stale skip flag that would drop a later real navigation.
  const skipLoadForRef = useRef<number | null>(null)

  // Chat sidebar collapse (Ctrl+B via custom event)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    return localStorage.getItem('gungnir_chat_sidebar') === 'true'
  })


  const [editingTitleId, setEditingTitleId] = useState<number | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [hasGeneratedTitle, setHasGeneratedTitle] = useState(() => {
    try { const saved = localStorage.getItem('gungnir_titles_generated'); return new Set(JSON.parse(saved || '[]')) }
    catch { return new Set() }
  })

  const [showApiKeysModal, setShowApiKeysModal] = useState(false)
  const [showUserModal, setShowUserModal] = useState(false)
  const [currentUser, setCurrentUser] = useState<any>(() => {
    try { const saved = localStorage.getItem('gungnir_current_user'); return saved ? JSON.parse(saved) : null }
    catch { return null }
  })

  // Folders (classification des conversations) — placé après currentUser pour éviter TDZ
  const [folders, setFolders] = useState<any[]>([])
  const [folderFilter, setFolderFilter] = useState<number | null | 'all'>('all')
  // Drag & drop état : convo en cours de drag + cible survolée
  // useRef pour éviter les closures stales sur les handlers (le dragover doit
  // pouvoir preventDefault() immédiatement, sans attendre un re-render React).
  const draggedConvoRef = useRef<number | null>(null)
  const [draggedConvoId, setDraggedConvoId] = useState<number | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<number | null | 'none' | undefined>(undefined)
  const [foldersCollapsed, setFoldersCollapsed] = useState(() => localStorage.getItem('gungnir_folders_collapsed') === 'true')
  const toggleFoldersCollapsed = () => {
    setFoldersCollapsed(prev => {
      const next = !prev
      localStorage.setItem('gungnir_folders_collapsed', String(next))
      return next
    })
  }
  const handleDropOnFolder = async (convoId: number, folderId: number | null) => {
    // Optimistic update
    const current = useStore.getState().conversations
    setConversations(current.map(c => c.id === convoId ? { ...c, folder_id: folderId } : c))
    // Basculer automatiquement sur le dossier cible pour voir le résultat
    setFolderFilter(folderId)
    try {
      await api.moveConversationToFolder(convoId, folderId)
    } catch (err) {
      console.error('Drop move error:', err)
      reloadConversations() // revert
    }
  }
  const reloadFolders = useCallback(async () => {
    try { setFolders(await api.listFolders()) } catch { /* ignore */ }
  }, [])
  useEffect(() => { reloadFolders() }, [reloadFolders])
  const reloadConversations = useCallback(async () => {
    try { setConversations(await api.getConversations(currentUser?.id)) } catch { /* ignore */ }
  }, [currentUser?.id, setConversations])
  const handleCreateFolder = async () => {
    const name = window.prompt('Nom du nouveau dossier :')?.trim()
    if (!name) return
    try { await api.createFolder({ name }); reloadFolders() } catch (err) { console.error('Create folder error:', err) }
  }
  const handleDeleteFolder = async (folderId: number) => {
    if (!window.confirm('Supprimer ce dossier ? Les conversations qu\'il contient seront conservées (sans dossier).')) return
    try { await api.deleteFolder(folderId); reloadFolders(); reloadConversations() } catch (err) { console.error('Delete folder error:', err) }
  }

  const [showVoiceModal, setShowVoiceModal] = useState(false)

  // ── Image generation modal state ────────────────────────────────────────
  type ImageModelInfo = { id: string; label: string; sizes: string[]; default_size: string; quality?: boolean }
  type ImageProvidersCatalog = Array<{ provider: string; has_key: boolean; models: ImageModelInfo[] }>
  const [showImageGenModal, setShowImageGenModal] = useState(false)
  const [imgGenCatalog, setImgGenCatalog] = useState<ImageProvidersCatalog>([])
  const [imgGenProvider, setImgGenProvider] = useState<string>('')
  const [imgGenModel, setImgGenModel] = useState<string>('')
  const [imgGenSize, setImgGenSize] = useState<string>('1024x1024')
  const [imgGenPrompt, setImgGenPrompt] = useState<string>('')
  const [imgGenLoading, setImgGenLoading] = useState(false)
  const [imgGenError, setImgGenError] = useState<string>('')
  // Charge le catalogue une fois ; re-fetch après ajout/retrait d'une clé provider
  useEffect(() => {
    const load = () => {
      apiFetch('/api/chat/image/models').then(r => r.json()).then((data: any) => {
        const providers: ImageProvidersCatalog = (data?.providers || []).filter((p: any) => p.has_key)
        setImgGenCatalog(providers)
        if (providers.length > 0 && !imgGenProvider) {
          setImgGenProvider(providers[0].provider)
          const firstModel = providers[0].models[0]
          if (firstModel) {
            setImgGenModel(firstModel.id)
            setImgGenSize(firstModel.default_size || firstModel.sizes[0] || '1024x1024')
          }
        }
      }).catch(() => { /* ignore */ })
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [pttStatus, setPttStatus] = useState<'idle' | 'recording' | 'processing'>('idle')
  const recognitionRef = useRef<any>(null)

  // ── Prompt improvement : LLM réécrit le draft avant envoi ──────────
  const [improving, setImproving] = useState(false)
  const [originalBeforeImprove, setOriginalBeforeImprove] = useState<string | null>(null)

  const improvePrompt = useCallback(async () => {
    const draft = input.trim()
    if (!draft || improving || isLoading) return
    // Sauvegarde du draft pour Undo (Escape) avant le call
    setOriginalBeforeImprove(draft)
    setImproving(true)
    try {
      const res = await apiFetch('/api/chat/improve-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: draft,
          provider: selectedProvider,
          model: selectedModel,
        }),
      })
      const data = await res.json()
      if (data?.ok && data.prompt) {
        setInput(data.prompt)
        setTimeout(() => inputRef.current?.focus(), 30)
      } else {
        console.warn('Improve prompt failed:', data?.error)
        setOriginalBeforeImprove(null)  // pas de undo si rien n'a changé
      }
    } catch (e) {
      console.error('Improve prompt error:', e)
      setOriginalBeforeImprove(null)
    } finally {
      setImproving(false)
    }
  }, [input, improving, isLoading, selectedProvider, selectedModel])

  // ── TTS : lecture vocale des réponses LLM (Web Speech API) ──────────
  // Toggle persisté en localStorage. Utilise speechSynthesis natif du
  // navigateur — zéro backend, fonctionne offline, voix OS-dépendantes.
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('chat.ttsEnabled') === '1' } catch { return false }
  })
  const [ttsSpeaking, setTtsSpeaking] = useState(false)
  const toggleTts = useCallback(() => {
    setTtsEnabled(v => {
      const next = !v
      try { localStorage.setItem('chat.ttsEnabled', next ? '1' : '0') } catch { /* ignore */ }
      // Si on désactive pendant une lecture, on coupe tout de suite
      // (navigateur ET cloud audio en cours).
      if (!next) {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel()
        }
        if (cloudAudioRef.current) {
          cloudAudioRef.current.pause()
          cloudAudioRef.current.src = ''
          cloudAudioRef.current = null
        }
        setTtsSpeaking(false)
      }
      return next
    })
  }, [])

  // Référence au dernier HTMLAudioElement cloud (pour pouvoir l'arrêter).
  const cloudAudioRef = useRef<HTMLAudioElement | null>(null)

  const speakText = useCallback((text: string) => {
    if (!text) return
    // Strip markdown basique avant d'envoyer au TTS — sinon le synthétiseur
    // lit les `*`, `#`, les liens URL, le code… littéralement.
    const plain = text
      .replace(/```[\s\S]*?```/g, '')        // blocs de code
      .replace(/`([^`]+)`/g, '$1')           // code inline
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // liens
      .replace(/^#{1,6}\s+/gm, '')           // titres
      .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
      .replace(/\*([^*]+)\*/g, '$1')         // italic
      .replace(/^[-*]\s+/gm, '')             // bullets
      .replace(/\n{2,}/g, '. ')              // paragraphes → pause
      .trim()
    if (!plain) return

    // Prefs depuis localStorage (écrites par Settings → Voix).
    let prefs: any = null
    try {
      const raw = localStorage.getItem('chat.tts.prefs')
      if (raw) prefs = JSON.parse(raw)
    } catch { /* ignore */ }
    const engine = prefs?.engine || 'browser'

    // Coupe toute lecture en cours (navigateur + cloud) avant de relancer.
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
    if (cloudAudioRef.current) {
      cloudAudioRef.current.pause()
      cloudAudioRef.current.src = ''
      cloudAudioRef.current = null
    }

    // ─── Engine "browser" : Web Speech API native ───────────
    if (engine === 'browser') {
      if (typeof window === 'undefined' || !window.speechSynthesis) return
      const utter = new SpeechSynthesisUtterance(plain)
      utter.rate = prefs?.rate ?? 1.05
      utter.pitch = prefs?.pitch ?? 1.0
      utter.volume = prefs?.volume ?? 1.0
      const forcedLang = prefs?.lang && prefs.lang !== 'auto' ? prefs.lang : null
      utter.lang = forcedLang
        || (i18n.language === 'en' ? 'en-US' : `${i18n.language}-${i18n.language.toUpperCase()}`)
      if (prefs?.voiceURI) {
        const voices = window.speechSynthesis.getVoices() || []
        const found = voices.find(v => v.voiceURI === prefs.voiceURI)
        if (found) utter.voice = found
      }
      utter.onstart = () => setTtsSpeaking(true)
      utter.onend = () => setTtsSpeaking(false)
      utter.onerror = () => setTtsSpeaking(false)
      window.speechSynthesis.speak(utter)
      return
    }

    // ─── Engine cloud : POST /api/chat/tts → blob MP3 → Audio ───
    const body: any = { text: plain, provider: engine }
    if (engine === 'openai') {
      body.voice = prefs?.openaiVoice || 'alloy'
      body.model = prefs?.openaiModel || 'tts-1'
      body.speed = prefs?.openaiSpeed ?? 1.0
    } else if (engine === 'elevenlabs') {
      body.voice = prefs?.elevenVoiceId || '21m00Tcm4TlvDq8ikWAM'
      body.model = prefs?.elevenModelId || 'eleven_multilingual_v2'
    } else if (engine === 'google') {
      body.lang = prefs?.lang && prefs.lang !== 'auto'
        ? prefs.lang
        : (i18n.language === 'en' ? 'en-US' : 'fr-FR')
      if (prefs?.googleVoice) body.voice = prefs.googleVoice
      body.speed = prefs?.googleSpeed ?? 1.0
    } else if (engine === 'custom') {
      body.voice = prefs?.customVoice || 'alloy'
      body.model = prefs?.customModel || 'tts-1'
      body.speed = prefs?.customSpeed ?? 1.0
    }
    setTtsSpeaking(true)
    apiFetch('/api/chat/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        console.warn('Cloud TTS failed:', err?.error || r.status)
        setTtsSpeaking(false)
        return
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      cloudAudioRef.current = audio
      audio.onended = () => {
        setTtsSpeaking(false)
        URL.revokeObjectURL(url)
        if (cloudAudioRef.current === audio) cloudAudioRef.current = null
      }
      audio.onerror = () => {
        setTtsSpeaking(false)
        URL.revokeObjectURL(url)
      }
      audio.play().catch(() => {
        setTtsSpeaking(false)
        URL.revokeObjectURL(url)
      })
    }).catch(e => {
      console.warn('Cloud TTS network error:', e)
      setTtsSpeaking(false)
    })
  }, [])

  // Déclenche le TTS à la fin du stream d'une réponse assistant — on
  // guette la transition isLoading: true → false, et on lit le dernier
  // message assistant en date s'il n'est pas vide.
  const prevLoadingRef = useRef(isLoading)
  useEffect(() => {
    const wasLoading = prevLoadingRef.current
    prevLoadingRef.current = isLoading
    if (!ttsEnabled) return
    if (wasLoading && !isLoading) {
      const last = [...messages].reverse().find(m => m.role === 'assistant')
      const content = (last?.content || '').trim()
      if (content) speakText(content)
    }
  }, [isLoading, ttsEnabled, messages, speakText])

  // Stop TTS (navigateur + cloud) quand on quitte / change de conversation
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
      if (cloudAudioRef.current) {
        cloudAudioRef.current.pause()
        cloudAudioRef.current.src = ''
        cloudAudioRef.current = null
      }
    }
  }, [currentConversation])

  // Pour l'engine cloud STT : MediaRecorder + chunks audio.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioStreamRef = useRef<MediaStream | null>(null)

  const startPTT = useCallback(async () => {
    // Lit les prefs PTT depuis localStorage (Settings → Voix).
    let prefs: { engine?: string; lang: string; continuous: boolean; interim: boolean } | null = null
    try {
      const raw = localStorage.getItem('chat.ptt.prefs')
      if (raw) prefs = JSON.parse(raw)
    } catch { /* ignore */ }
    const engine = prefs?.engine || 'browser'
    const forcedLang = prefs?.lang && prefs.lang !== 'auto' ? prefs.lang : null
    console.info('[PTT] startPTT', { engine, lang: forcedLang, prefs })

    // ─── Engine "browser" : Web Speech Recognition ───────────
    if (engine === 'browser') {
      // Context check : Web Speech API refuse en HTTP (sauf localhost). Sans
      // ce warning l'user tape dans le vide pendant 5 min en se demandant.
      const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      if (!isSecure) {
        alert('La reconnaissance vocale exige HTTPS. Passe Gungnir derrière un reverse-proxy TLS ou configure un certificat.')
        return
      }

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      if (!SpeechRecognition) {
        alert('Ce navigateur ne supporte pas la reconnaissance vocale (essaie Chrome ou Edge).')
        return
      }
      if (recognitionRef.current) {
        console.info('[PTT] Already running, ignore click')
        return
      }

      // Normalise la locale : i18n.language peut déjà contenir une région (ex "fr-FR"),
      // dans ce cas ne pas concaténer en "fr-FR-FR-FR" qui est invalide.
      const lang = forcedLang || (
        i18n.language.includes('-') ? i18n.language :
        i18n.language === 'en' ? 'en-US' :
        `${i18n.language}-${i18n.language.toUpperCase()}`
      )

      const recognition = new SpeechRecognition()
      recognition.lang = lang
      // Defaults : continuous + interim ACTIVÉS par défaut quand l'user n'a
      // pas configuré ses prefs. Sinon la Web Speech API s'arrête au premier
      // silence (~1-2s) et le bouton retombe en idle avant que l'user ait
      // fini sa phrase. On respecte les prefs si elles sont définies.
      recognition.interimResults   = prefs?.interim    === undefined ? true : !!prefs.interim
      recognition.continuous       = prefs?.continuous === undefined ? true : !!prefs.continuous
      recognition.maxAlternatives  = 1

      // Snapshot de l'input au moment de démarrer — on préfixe toutes les
      // transcriptions (interim + final) à partir d'ici pour afficher le texte
      // EN DIRECT. Sinon avec `continuous=true`, les navigateurs gardent les
      // résultats en interim très longtemps (parfois sans jamais les passer
      // en final), et le code précédent qui n'ajoutait que les finals
      // donnait l'impression que rien n'était retranscrit.
      const snapshot = (inputRef.current?.value ?? input ?? '')
      console.info('[PTT] Starting browser SpeechRecognition', { lang, continuous: recognition.continuous, interim: recognition.interimResults, snapshot_len: snapshot.length })
      recognition.onstart = () => {
        console.info('[PTT] onstart — listening')
        setPttStatus('recording')
      }
      recognition.onaudiostart = () => console.info('[PTT] onaudiostart — mic capturing')
      recognition.onsoundstart = () => console.info('[PTT] onsoundstart — sound detected')
      recognition.onspeechstart = () => console.info('[PTT] onspeechstart — speech detected')
      recognition.onresult = (event: any) => {
        // On reconstruit TOUT le transcript (interim + final) depuis le début
        // de la session, puis on replace sur le snapshot. Pas de risque de
        // doublon : on réécrit intégralement à chaque update.
        let transcript = ''
        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i]
          if (res[0]?.transcript) transcript += res[0].transcript
        }
        transcript = transcript.trim()
        console.info('[PTT] onresult', { transcript, results_count: event.results.length })
        if (transcript) {
          const sep = snapshot && !/\s$/.test(snapshot) ? ' ' : ''
          setInput(snapshot + sep + transcript)
        }
      }
      // Log explicite des erreurs — sans ça, un "not-allowed" ou un
      // "no-speech" ou un "network" plante silencieusement et l'user
      // croit que le bouton "ne marche pas".
      recognition.onerror = (e: any) => {
        const err = e?.error || 'unknown'
        console.warn('[PTT] SpeechRecognition error:', err, 'message=', e?.message)
        // "no-speech" est normal en continuous mode si l'user se tait un moment.
        // On laisse tourner sans arrêter ni alerter.
        if (err === 'no-speech') return
        if (err === 'not-allowed') {
          alert('Le micro est bloqué par le navigateur. Vérifie l\'icône cadenas dans la barre d\'adresse et autorise l\'accès audio.')
        } else if (err === 'network') {
          alert('Erreur réseau de reconnaissance vocale. Chrome envoie l\'audio vers Google Speech — vérifie ta connexion.')
        } else if (err === 'service-not-allowed') {
          alert('Le service de reconnaissance vocale est bloqué (peut-être par une extension ou un firewall).')
        }
        setPttStatus('idle')
        recognitionRef.current = null
      }
      recognition.onend = () => {
        console.info('[PTT] onend')
        setPttStatus('idle')
        recognitionRef.current = null
      }
      recognitionRef.current = recognition
      try {
        recognition.start()
      } catch (startErr: any) {
        console.warn('[PTT] recognition.start() threw:', startErr?.message)
        alert(`Impossible de démarrer la reconnaissance vocale : ${startErr?.message || 'erreur inconnue'}`)
        recognitionRef.current = null
        setPttStatus('idle')
      }
      return
    }

    // ─── Engine cloud (Whisper…) : MediaRecorder → POST /stt au stop ───
    if (mediaRecorderRef.current) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      audioStreamRef.current = stream
      // On tente webm/opus (Chrome/Firefox), fallback au défaut navigateur.
      let mimeType = ''
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus'
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm'
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4'
      }
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      audioChunksRef.current = []
      mr.ondataavailable = e => { if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data) }
      mr.onstart = () => setPttStatus('recording')
      mr.onstop = async () => {
        setPttStatus('processing')
        // Coupe le micro immédiatement pour l'indicateur OS
        if (audioStreamRef.current) {
          audioStreamRef.current.getTracks().forEach(t => t.stop())
          audioStreamRef.current = null
        }
        const chunks = audioChunksRef.current
        audioChunksRef.current = []
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
        if (!blob.size) { setPttStatus('idle'); mediaRecorderRef.current = null; return }
        try {
          const form = new FormData()
          const ext = (mimeType.includes('mp4') ? 'm4a' : 'webm')
          form.append('audio', blob, `recording.${ext}`)
          form.append('provider', engine)
          if (forcedLang) form.append('lang', forcedLang)
          else form.append('lang', i18n.language === 'en' ? 'en-US' : 'fr-FR')
          // Model hint pour mistral / custom (openai = whisper-1 hardcodé backend)
          if (engine === 'mistral' && (prefs as any)?.mistralModel) {
            form.append('model', (prefs as any).mistralModel)
          } else if (engine === 'custom' && (prefs as any)?.customModel) {
            form.append('model', (prefs as any).customModel)
          }
          const r = await apiFetch('/api/chat/stt', { method: 'POST', body: form })
          const data = await r.json()
          if (data?.ok && data.text) {
            setInput(prev => (prev ? prev + ' ' : '') + data.text.trim())
            setTimeout(() => inputRef.current?.focus(), 50)
          } else {
            console.warn('Cloud STT failed:', data?.error)
          }
        } catch (e) {
          console.warn('Cloud STT network error:', e)
        } finally {
          setPttStatus('idle')
          mediaRecorderRef.current = null
        }
      }
      mr.onerror = () => { setPttStatus('idle'); mediaRecorderRef.current = null }
      mediaRecorderRef.current = mr
      mr.start()
    } catch (e) {
      console.warn('Mic access denied or unavailable:', e)
      setPttStatus('idle')
    }
  }, [])

  const stopPTT = useCallback(() => {
    // Engine browser → recognition.stop() ; engine cloud → mediaRecorder.stop()
    if (recognitionRef.current) {
      setPttStatus('processing')
      recognitionRef.current.stop()
      return
    }
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop() } catch { /* ignore */ }
    }
  }, [])

  // Listen for Ctrl+B custom event from useKeyboard hook
  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed(prev => {
      const newVal = !prev
      localStorage.setItem('gungnir_chat_sidebar', String(newVal))
      return newVal
    })
  }, [])

  useEffect(() => {
    const handler = () => toggleSidebar()
    window.addEventListener('gungnir:toggle-chat-sidebar', handler)
    return () => window.removeEventListener('gungnir:toggle-chat-sidebar', handler)
  }, [toggleSidebar])

  // ─── Reload conversations when user changes ───────────────────────
  useEffect(() => {
    const loadUserConversations = async () => {
      try {
        const convos = await api.getConversations(currentUser?.id)
        setConversations(convos)
        // Reset current conversation if it doesn't belong to this user
        if (currentConversation && !convos.find((c: any) => c.id === currentConversation)) {
          setCurrentConversation(null)
          setMessages([])
        }
      } catch { /* ignore */ }
    }
    loadUserConversations()
  }, [currentUser?.id])

  // ─── Welcome onboarding gate ──────────────────────────────────────
  // On first mount (or when the user changes), check whether the caller
  // needs the welcome chat. If they already have an API key and haven't
  // finished onboarding, create+open the welcome conversation once.
  useEffect(() => {
    if (!currentUser?.id) return
    onboardingAutoOpenedRef.current = false
    const loadOnboarding = async () => {
      try {
        const res = await apiFetch('/api/onboarding/state')
        if (!res.ok) return
        const data = await res.json()
        setOnboardingState(data)

        if (data.step === 'done' || !data.has_api_key) return

        // Needs onboarding + has key: create welcome conv if missing, then open it
        if (!onboardingAutoOpenedRef.current) {
          onboardingAutoOpenedRef.current = true
          let convoId = data.welcome_convo_id
          if (!convoId) {
            try {
              const createRes = await apiFetch('/api/onboarding/welcome', { method: 'POST' })
              if (createRes.ok) {
                const created = await createRes.json()
                convoId = created.welcome_convo_id
                setOnboardingState((prev) => prev ? { ...prev, welcome_convo_id: convoId, step: 'in_progress' } : prev)
                // Refresh the conversations list so the sidebar shows "Bienvenue"
                try {
                  const convos = await api.getConversations(currentUser?.id)
                  setConversations(convos)
                } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
          }
          if (convoId) setCurrentConversation(convoId)
        }
      } catch { /* ignore */ }
    }
    loadOnboarding()
  }, [currentUser?.id])

  const refreshOnboardingState = useCallback(async () => {
    if (!currentUser?.id) return
    try {
      const res = await apiFetch('/api/onboarding/state')
      if (!res.ok) return
      const data = await res.json()
      setOnboardingState(data)

      // If the user just configured their API key elsewhere and came back,
      // auto-create + open the welcome conversation now.
      if (data.step !== 'done' && data.has_api_key && !onboardingAutoOpenedRef.current) {
        onboardingAutoOpenedRef.current = true
        let convoId = data.welcome_convo_id
        if (!convoId) {
          try {
            const createRes = await apiFetch('/api/onboarding/welcome', { method: 'POST' })
            if (createRes.ok) {
              const created = await createRes.json()
              convoId = created.welcome_convo_id
              setOnboardingState((prev) => prev ? { ...prev, welcome_convo_id: convoId, step: 'in_progress' } : prev)
              try {
                const convos = await api.getConversations(currentUser?.id)
                setConversations(convos)
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
        if (convoId) setCurrentConversation(convoId)
      }
    } catch { /* ignore */ }
  }, [currentUser?.id])

  // Re-fetch onboarding state when the tab regains focus or the user comes
  // back from Settings → Providers — so the welcome card disappears as soon
  // as the key lands in UserSettings.provider_keys.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshOnboardingState()
    }
    window.addEventListener('focus', refreshOnboardingState)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refreshOnboardingState)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshOnboardingState])

  const skipOnboarding = async () => {
    try {
      await apiFetch('/api/onboarding/skip', { method: 'POST' })
      setOnboardingState((prev) => prev ? { ...prev, step: 'done' } : prev)
    } catch { /* ignore */ }
  }

  // ─── Conversation operations ───────────────────────────────────────
  const handleDeleteConversation = async (id: number, confirm: boolean) => {
    if (!confirm) { setDeletingId(null); return }
    try {
      await api.deleteConversation(id)
      setConversations(conversations.filter(c => c.id !== id))
      if (currentConversation === id) { setCurrentConversation(null); setMessages([]) }
    } catch (err) { console.error('Delete error:', err) }
    finally { setDeletingId(null) }
  }

  const handleStartEditing = (convo: any) => { setEditingTitleId(convo.id); setEditTitleValue(convo.title) }

  const handleSaveTitle = async (id: number) => {
    const newTitle = editTitleValue.trim()
    if (!newTitle) { setEditingTitleId(null); return }
    try {
      await api.updateConversation(id, { title: newTitle })
      setConversations(conversations.map(c => c.id === id ? { ...c, title: newTitle } : c))
    } catch (err) { console.error('Update title error:', err) }
    finally { setEditingTitleId(null) }
  }

  const handleCancelEdit = () => { setEditingTitleId(null); setEditTitleValue('') }

  const generateTitleForConversation = useCallback(async (conversationId: number, userMessage: string) => {
    if (hasGeneratedTitle.has(conversationId)) return
    try {
      const result = await api.generateTitle(conversationId, selectedProvider, selectedModel)
      const newTitle = result.title || userMessage.substring(0, 50).trim()
      setConversations(useStore.getState().conversations.map(c => c.id === conversationId ? { ...c, title: newTitle } : c))
      const updatedSet = new Set(hasGeneratedTitle); updatedSet.add(conversationId)
      setHasGeneratedTitle(updatedSet)
      localStorage.setItem('gungnir_titles_generated', JSON.stringify([...updatedSet]))
    } catch (err) { console.error('Auto-title generation error:', err) }
  }, [hasGeneratedTitle])

  // ─── Model loading ─────────────────────────────────────────────────
  useEffect(() => {
    if (!config?.providers) return
    const initialMap: Record<string, string[]> = {}
    Object.entries(config.providers).forEach(([name, p]) => {
      const prov = p as any
      if ((prov.enabled || prov.has_api_key) && prov.models?.length > 0) initialMap[name] = prov.models
    })
    if (Object.keys(initialMap).length > 0) setProviderModelsMap(initialMap)

    const enabledNames = Object.entries(config.providers).filter(([, p]) => (p as any).enabled || (p as any).has_api_key).map(([name]) => name)
    Promise.all(
      enabledNames.map(async (name) => {
        try { const res = await apiFetch(`/api/models/${name}`); const data = await res.json(); return { name, models: (data.models || []) as string[] } }
        catch { return { name, models: [] } }
      })
    ).then(results => {
      setProviderModelsMap(prev => {
        const next = { ...prev }
        results.forEach(({ name, models }) => { if (models.length > 0) next[name] = models })
        return next
      })
    })
  }, [config])

  const groupedProviders = Object.entries(providerModelsMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, models]) => {
      const defaultModel = (config?.providers?.[name] as any)?.default_model as string | undefined
      const sorted = [...models].sort((a, b) => a.localeCompare(b))
      const filtered = modelSearch.trim() ? sorted.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase())) : sorted
      return { name, models: filtered, allModels: sorted, defaultModel }
    })
    .filter(p => p.allModels.length > 0)

  useEffect(() => {
    api.getPersonalities().then((data: any) => {
      if (Array.isArray(data)) setPersonalities(data)
      else if (data && Array.isArray(data.personalities)) setPersonalities(data.personalities)
      const list = Array.isArray(data) ? data : (data?.personalities || [])
      const active = list.find((p: any) => p.active)
      if (active) setActivePersonality(active.name)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    api.getSkills().then((data: any) => {
      const list = Array.isArray(data) ? data : []
      setAllSkills(list)
      setFavoriteSkills(list.filter((s: any) => s.is_favorite))
      // Check active skill
      api.getActiveSkill().then((res: any) => {
        if (res?.skill) setActiveSkill(res.skill.name || res.skill)
      }).catch(() => {})
    }).catch(() => {})
  }, [])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => {
    if (!currentConversation) return
    if (skipLoadForRef.current === currentConversation) {
      skipLoadForRef.current = null
      return
    }
    loadMessages()
  }, [currentConversation])
  useEffect(() => {
    const totalMsgs = messages.length
    const totalTokens = messages.reduce((acc, m) => acc + (m.content.length / 4), 0)
    setStats({ tokens: Math.round(totalTokens), messages: totalMsgs, cost: totalTokens * 0.00001 })
  }, [messages])

  const loadMessages = async () => {
    if (!currentConversation) return
    try { const msgs = await api.getMessages(currentConversation); setMessages(msgs) }
    catch (err) { console.error('Load messages error:', err) }
  }

  // ─── Automata tab helpers ──────────────────────────────────────────
  const automataFetch = async (path: string) => {
    const token = localStorage.getItem('gungnir_auth_token')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`/api/plugins/scheduler${path}`, { headers })
    if (!res.ok) return null
    return res.json()
  }
  const loadAutomataTasks = useCallback(async () => {
    const data = await automataFetch('/tasks')
    if (data) setAutomataTasks(data.tasks || [])
  }, [])
  const loadAutomataHistory = useCallback(async (taskId: string) => {
    const data = await automataFetch(`/tasks/${taskId}/history`)
    if (data) setAutomataHistory(data.entries || [])
  }, [])
  useEffect(() => {
    if (sidebarTab === 'automata') loadAutomataTasks()
  }, [sidebarTab, loadAutomataTasks])
  useEffect(() => {
    if (activeAutomataTaskId) loadAutomataHistory(activeAutomataTaskId)
    else setAutomataHistory([])
  }, [activeAutomataTaskId, loadAutomataHistory])

  const activeAutomataTask = activeAutomataTaskId
    ? automataTasks.find(t => t.id === activeAutomataTaskId) || null
    : null

  const handleNewChat = async () => {
    try {
      const payload = { title: 'Nouveau chat', provider: selectedProvider, model: selectedModel || 'mistralai/mistral-large', user_id: currentUser?.id }
      const newConvo = await api.createConversation(payload)
      // Si un dossier précis est filtré, la nouvelle conversation y atterrit automatiquement
      const targetFolder = typeof folderFilter === 'number' ? folderFilter : null
      if (targetFolder !== null && newConvo.id) {
        try { await api.moveConversationToFolder(newConvo.id, targetFolder) } catch { /* ignore */ }
      }
      const fullConvo = {
        ...payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...newConvo,
        folder_id: targetFolder,
      }
      setConversations([fullConvo, ...conversations])
      skipLoadForRef.current = fullConvo.id
      setCurrentConversation(fullConvo.id)
      setMessages([])
    } catch (err) { console.error('New chat error:', err) }
  }

  const handleNewChatWithSummary = async (summary: string) => {
    try {
      const payload = { title: 'Suite de conversation', provider: selectedProvider, model: selectedModel || 'mistralai/mistral-large', user_id: currentUser?.id }
      const newConvo = await api.createConversation(payload)
      const targetFolder = typeof folderFilter === 'number' ? folderFilter : null
      if (targetFolder !== null && newConvo.id) {
        try { await api.moveConversationToFolder(newConvo.id, targetFolder) } catch { /* ignore */ }
      }
      const fullConvo = {
        ...payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...newConvo,
        folder_id: targetFolder,
      }
      setConversations([fullConvo, ...conversations])
      skipLoadForRef.current = fullConvo.id
      setCurrentConversation(fullConvo.id)
      setMessages([])
      setInput(`Voici le résumé de notre conversation précédente pour contexte :\n\n${summary}\n\nOn peut continuer à partir de là.`)
    } catch (err) { console.error('New chat with summary error:', err) }
  }

  // Set mémorisé des IDs de modèles image-gen — alimenté depuis imgGenCatalog.
  // Sert à détecter quand l'utilisateur sélectionne un modèle image dans le
  // dropdown du chat et à router automatiquement vers /api/chat/image.
  const imageModelIds = useMemo(() => {
    const s = new Set<string>()
    for (const p of imgGenCatalog) for (const m of p.models) s.add(m.id)
    return s
  }, [imgGenCatalog])

  const handleSend = async (overrideText?: string) => {
    const effectiveInput = overrideText ?? input
    if (!effectiveInput.trim() && attachedFiles.length === 0) return
    // Si une réponse est déjà en cours de génération : on abort le stream
    // actuel et on mémorise le dernier message user pour l'enrichir au
    // prochain envoi. On sort ensuite : l'abort va rejeter la promise en
    // cours, qui remettra isLoading=false ; l'utilisateur peut alors
    // renvoyer. Si l'utilisateur appuie direct sur Entrée à nouveau, le
    // prochain appel verra `pendingContextRef` et préfixera le contexte.
    if (isLoading) {
      // Récupère le dernier message user pour l'inclure comme contexte.
      const msgs = useStore.getState().messages
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      if (lastUser) {
        pendingContextRef.current = lastUser.content.replace(/\n\[Image jointe\]/g, '')
      }
      // Si l'utilisateur a tapé un nouveau message, on le met en file
      // d'attente : il sera rejoué automatiquement après l'abort par le
      // useEffect qui observe isLoading.
      if (effectiveInput.trim()) {
        queuedSendRef.current = effectiveInput.trim()
        setInput('')
      }
      abortRef.current?.abort()
      return
    }
    // Si on a un contexte en attente (après un abort précédent), on le
    // préfixe au message courant pour que le LLM ait le fil complet.
    let prefixed = effectiveInput
    if (pendingContextRef.current) {
      prefixed = `[Contexte message précédent interrompu] ${pendingContextRef.current}\n\n[Nouveau message] ${effectiveInput}`
      pendingContextRef.current = null
    }

    // Auto-create conversation if none selected
    let convoId: number | null = currentConversation
    if (!convoId) {
      try {
        const payload = { title: 'Nouveau chat', provider: selectedProvider, model: selectedModel || 'mistralai/mistral-large', user_id: currentUser?.id }
        const newConvo = await api.createConversation(payload)
        const targetFolder = typeof folderFilter === 'number' ? folderFilter : null
        if (targetFolder !== null && newConvo.id) {
          try { await api.moveConversationToFolder(newConvo.id, targetFolder) } catch { /* ignore */ }
        }
        const fullConvo = {
          ...payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...newConvo,
          folder_id: targetFolder,
        }
        setConversations([fullConvo, ...conversations])
        skipLoadForRef.current = fullConvo.id
        setCurrentConversation(fullConvo.id)
        convoId = fullConvo.id
      } catch (err) {
        console.error('Auto-create conversation error:', err)
        return
      }
    }

    // `userMessage` = ce que l'utilisateur voit dans sa bulle (version brute).
    // `sentMessage` = ce qu'on envoie au LLM (potentiellement enrichi du
    // contexte du message précédent interrompu).
    const userMessage = effectiveInput.trim()
    const sentMessage = prefixed.trim()
    const currentImages = attachedFiles.filter(f => f.type.startsWith('image/')).map(f => f.dataUrl)
    const currentDocs = attachedFiles.filter(f => !f.type.startsWith('image/'))
    // Pour les documents non-image, ajouter le contenu texte au message
    let fullMessage = sentMessage
    if (currentDocs.length > 0) {
      const docTexts = currentDocs.map(d => {
        // Pour les fichiers texte, extraire le contenu base64
        if (d.type.startsWith('text/') || d.type === 'application/json') {
          try {
            const b64 = d.dataUrl.split(',')[1]
            return `\n\n--- Fichier: ${d.name} ---\n${atob(b64)}\n--- Fin ${d.name} ---`
          } catch { return '' }
        }
        return `\n[Fichier joint: ${d.name} (${d.type})]`
      })
      fullMessage += docTexts.join('')
    }
    setInput('')
    setAttachedFiles([])
    setLoading(true)
    setLoadingConvoId(convoId)
    // ── Shortcut : modèle image-gen sélectionné dans le dropdown chat ─────
    // Au lieu d'envoyer le prompt via /chat/stream (qui retournerait une
    // bulle vide car chat streaming ne gère pas les output images), on
    // route directement vers /api/chat/image avec le prompt comme texte.
    if (imageModelIds.has(selectedModel)) {
      const imageSetMessages = useStore.getState().setMessages
      try {
        const resp = await apiFetch('/api/chat/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: fullMessage,
            provider: selectedProvider,
            model: selectedModel,
            size: '1024x1024',
            n: 1,
            conversation_id: convoId,
          }),
        })
        const data = await resp.json()
        if (!data?.ok) {
          addMessage({ id: Date.now(), role: 'user', content: fullMessage, created_at: new Date().toISOString() })
          addMessage({ id: Date.now() + 1, role: 'assistant', content: `[Erreur génération image : ${data?.error || 'inconnue'}]`, created_at: new Date().toISOString() })
        } else {
          try {
            const msgs = await api.getMessages(convoId!)
            imageSetMessages(msgs)
          } catch { /* ignore */ }
        }
      } catch (e: any) {
        addMessage({ id: Date.now(), role: 'user', content: fullMessage, created_at: new Date().toISOString() })
        addMessage({ id: Date.now() + 1, role: 'assistant', content: `[Erreur réseau : ${e?.message || 'inconnue'}]`, created_at: new Date().toISOString() })
      }
      setInput('')
      setAttachedFiles([])
      return
    }

    // Afficher le message user avec miniatures des images jointes
    const displayContent = currentImages.length > 0
      ? userMessage + currentImages.map(() => '\n[Image jointe]').join('')
      : fullMessage
    addMessage({ id: Date.now(), role: 'user', content: displayContent, created_at: new Date().toISOString(), images: currentImages })
    const streamingId = Date.now() + 1
    const setMessages = useStore.getState().setMessages
    addMessage({ id: streamingId, role: 'assistant', content: '', created_at: new Date().toISOString() })
    let streamedSoFar = ''
    // AbortController pour ce stream — stocké dans abortRef pour que le
    // bouton Stop (ou un renvoi pendant loading) puisse l'interrompre.
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const collectedToolEvents: any[] = []
      const response = await api.chat(
        convoId!,
        {
          message: fullMessage, provider: selectedProvider, model: selectedModel,
          ...(currentImages.length > 0 ? { images: currentImages } : {}),
        },
        {
          onToken: (chunk: string) => {
            if (useStore.getState().currentConversation !== convoId) return
            if (streamedSoFar.length === 0) {
              useStore.getState().setLoadingConvoId(null)
            }
            streamedSoFar += chunk
            const current = useStore.getState().messages
            setMessages(current.map(m => m.id === streamingId ? { ...m, content: streamedSoFar } : m))
          },
          onTool: (evt: any) => {
            // Collecte des tool_events — nécessaire pour afficher la
            // PermissionCard inline (évts avec result.pending_approval) dans
            // le chat, ainsi que les badges des tools exécutés.
            collectedToolEvents.push(evt)
            if (useStore.getState().currentConversation !== convoId) return
            const current = useStore.getState().messages
            setMessages(current.map(m => m.id === streamingId
              ? ({ ...m, tool_events: [...collectedToolEvents] } as any)
              : m))
          },
        },
        controller.signal,
      )
      // Si le stream a été abort par l'utilisateur, on garde le contenu
      // partiel déjà streamé et on marque la bulle en "(interrompu)" pour
      // qu'il voie clairement ce qui s'est passé.
      if ((response as any)?.aborted) {
        const stillOnSame = useStore.getState().currentConversation === convoId
        if (stillOnSame) {
          const current = useStore.getState().messages
          const partial = (response as any).content ?? streamedSoFar
          setMessages(current.map(m => m.id === streamingId
            ? { ...m, content: (partial || '') + '\n\n*(interrompu)*' }
            : m))
        }
      }
      // Read the live current conversation — the user may have switched
      // chats while we were awaiting. If so, the response is already saved
      // server-side and we must NOT append it to the local messages array
      // (which now belongs to a different conversation).
      const stillOnSameConvo = useStore.getState().currentConversation === convoId
      if (response.error) {
        if (stillOnSameConvo) {
          const current = useStore.getState().messages
          setMessages(current.map(m => m.id === streamingId
            ? { ...m, content: `[Erreur: ${response.error}]` }
            : m))
        }
      } else {
        if (stillOnSameConvo) {
          const current = useStore.getState().messages
          setMessages(current.map(m => m.id === streamingId
            ? ({
                ...m,
                content: response.content ?? streamedSoFar,
                model: response.model, provider: response.provider,
                tokens_input: response.tokens_input, tokens_output: response.tokens_output,
                tool_events: collectedToolEvents.length > 0 ? collectedToolEvents : undefined,
              } as any)
            : m))
        }
        // If agent switched provider/model, update the frontend selection
        if (response.switch_provider) {
          const sw = response.switch_provider
          if (sw.provider) setSelectedProvider(sw.provider)
          if (sw.model) setSelectedModel(sw.model)
        }
      }
      // Générer le titre après le 2e message user (pas le 1er — trop tôt pour identifier le sujet)
      // Only if we're still on the convo that just sent — otherwise `messages`
      // refers to a different conversation and the count is meaningless.
      if (stillOnSameConvo) {
        const userMsgCount = messages.filter(m => m.role === 'user').length + 1 // +1 pour celui qu'on vient d'envoyer
        if (userMsgCount === 2 && !hasGeneratedTitle.has(convoId!)) {
          generateTitleForConversation(convoId!, userMessage)
        }
      }
      // If we were in the welcome chat, re-fetch onboarding state so the UI
      // reflects the "done" flag as soon as finalize_onboarding has fired.
      if (onboardingState && onboardingState.step !== 'done' && onboardingState.welcome_convo_id === convoId) {
        try {
          const res = await apiFetch('/api/onboarding/state')
          if (res.ok) {
            const data = await res.json()
            setOnboardingState(data)
          }
        } catch { /* ignore */ }
      }
    } catch (err) { console.error('Chat error:', err) }
    abortRef.current = null
    setLoading(false)
    setLoadingConvoId(null)
  }

  // Si l'utilisateur a envoyé un message pendant la génération précédente,
  // il a été mis en file d'attente (queuedSendRef). Dès que le handler en
  // cours se termine (isLoading → false), on le rejoue automatiquement
  // avec le contexte du message interrompu.
  useEffect(() => {
    if (!isLoading && queuedSendRef.current) {
      const queued = queuedSendRef.current
      queuedSendRef.current = null
      // Petit délai pour laisser React finaliser le setLoading avant
      // que handleSend relise l'état.
      setTimeout(() => handleSend(queued), 50)
    }

  }, [isLoading])

  // Relance une réponse en recyclant la bulle assistant cliquée : trouve le
  // message utilisateur qui la précède, vide le contenu de l'assistant, et
  // streame la nouvelle réponse dedans.
  const regenerateResponse = async (assistantMsgId: number) => {
    if (isLoading) return
    const msgs = useStore.getState().messages
    const idx = msgs.findIndex(m => m.id === assistantMsgId)
    if (idx <= 0) return
    // Remonte jusqu'au dernier message user avant cet assistant
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userIdx = i; break }
    }
    if (userIdx === -1) return
    const userMsg = msgs[userIdx]
    const convoId = currentConversation
    if (!convoId) return

    // Vide la bulle assistant en place
    const setMessagesFn = useStore.getState().setMessages
    setMessagesFn(msgs.map(m => m.id === assistantMsgId ? { ...m, content: '', tokens_input: undefined, tokens_output: undefined } : m))
    setLoading(true)
    setLoadingConvoId(convoId)

    let streamedSoFar = ''
    try {
      const collectedToolEvents: any[] = []
      const response = await api.chat(
        convoId,
        {
          message: userMsg.content,
          provider: selectedProvider,
          model: selectedModel,
          ...(userMsg.images && userMsg.images.length > 0 ? { images: userMsg.images } : {}),
        },
        {
          onToken: (chunk: string) => {
            if (useStore.getState().currentConversation !== convoId) return
            if (streamedSoFar.length === 0) useStore.getState().setLoadingConvoId(null)
            streamedSoFar += chunk
            const current = useStore.getState().messages
            setMessagesFn(current.map(m => m.id === assistantMsgId ? { ...m, content: streamedSoFar } : m))
          },
          onTool: (evt: any) => {
            collectedToolEvents.push(evt)
            if (useStore.getState().currentConversation !== convoId) return
            const current = useStore.getState().messages
            setMessagesFn(current.map(m => m.id === assistantMsgId
              ? ({ ...m, tool_events: [...collectedToolEvents] } as any)
              : m))
          },
        },
      )
      const stillOnSameConvo = useStore.getState().currentConversation === convoId
      if (stillOnSameConvo) {
        const current = useStore.getState().messages
        if (response.error) {
          setMessagesFn(current.map(m => m.id === assistantMsgId
            ? { ...m, content: `[Erreur: ${response.error}]` }
            : m))
        } else {
          setMessagesFn(current.map(m => m.id === assistantMsgId
            ? ({
                ...m,
                content: response.content ?? streamedSoFar,
                model: response.model, provider: response.provider,
                tokens_input: response.tokens_input, tokens_output: response.tokens_output,
                tool_events: collectedToolEvents.length > 0 ? collectedToolEvents : undefined,
              } as any)
            : m))
        }
      }
    } catch (err) { console.error('Regenerate error:', err) }
    setLoading(false)
    setLoadingConvoId(null)
  }

  // Envoie un feedback 👍/👎 au plugin Conscience pour alimenter le système
  // de scoring (relevance) de l'agent — base future de l'auto-évaluation.
  const scoreResponse = async (assistantMsgId: number, value: 'up' | 'down') => {
    try {
      const score = value === 'up' ? 1.0 : 0.0
      await api.scoreInteraction({
        interaction_type: 'chat_response',
        scores: { relevance: score },
        triggered_by: 'user',
        description: `Chat msg #${assistantMsgId} — ${value === 'up' ? 'pertinent' : 'hors-sujet'}`,
      })
    } catch (err) {
      console.error('Score error:', err)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    // Escape annule la dernière amélioration de prompt (restaure le draft
    // original). Utile si le user n'aime pas la reformulation.
    if (e.key === 'Escape' && originalBeforeImprove !== null && !improving) {
      e.preventDefault()
      setInput(originalBeforeImprove)
      setOriginalBeforeImprove(null)
    }
  }

  const formatModelName = (modelId: string) => { if (!modelId) return '—'; const parts = modelId.split('/'); return parts[parts.length - 1] || modelId }
  const formatCost = (cost: number) => `$${cost.toFixed(4)}`
  const sessionTokens = messages.reduce((acc, m: any) => acc + (m.tokens_input || 0) + (m.tokens_output || 0), 0)
  const filteredConversations = conversations.filter(c => {
    if (!(c.title || '').toLowerCase().includes(searchQuery.toLowerCase())) return false
    if (folderFilter === 'all') return true
    if (folderFilter === null) return !c.folder_id
    return c.folder_id === folderFilter
  }).sort((a: any, b: any) => {
    // Conversations épinglées remontent en haut. À pin égal, on respecte
    // l'ordre serveur (updated_at desc).
    const ap = a.is_pinned ? 1 : 0
    const bp = b.is_pinned ? 1 : 0
    if (ap !== bp) return bp - ap
    return 0
  })

  // Toggle l'épinglage d'une conversation. Optimistic update + revert si l'API échoue.
  const togglePinConversation = async (convoId: number, currentPinned: boolean) => {
    const next = !currentPinned
    setConversations(conversations.map(c => c.id === convoId ? { ...c, is_pinned: next } : c))
    try {
      await apiFetch(`/api/conversations/${convoId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_pinned: next }),
      })
    } catch (err) {
      console.error('Pin toggle failed:', err)
      setConversations(conversations.map(c => c.id === convoId ? { ...c, is_pinned: currentPinned } : c))
    }
  }

  return (
    <div className="flex h-full" style={{ background: 'var(--bg-primary)' }}>

      {/* ── CHAT SIDEBAR ── */}
      <aside className={`flex-shrink-0 flex flex-col transition-all duration-300 ease-in-out ${isSidebarCollapsed ? 'w-16' : 'w-[280px]'}`}
        style={{ background: 'var(--bg-primary)', borderRight: '1px solid var(--border-subtle)' }}>
        <div className={`flex flex-col h-full ${isSidebarCollapsed ? 'items-center px-2' : ''}`}>
          <div className={`flex items-center justify-between ${isSidebarCollapsed ? 'px-2 py-4' : 'px-4 py-4'}`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            {!isSidebarCollapsed ? (
              <>
                <div className="flex items-center gap-2">
                  <AgentAvatar size={28} />
                  <span className="font-bold text-base tracking-wide gradient-text" style={{ color: 'var(--text-primary)' }}>{agentName.toUpperCase()}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={handleNewChat} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: 'var(--text-muted)' }} title={t('chat.newChat')}>
                    <Plus className="w-4 h-4" />
                  </button>
                  <button onClick={toggleSidebar} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: 'var(--text-muted)' }} title={`${t('nav.collapse')} (Ctrl+B)`}>
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>
              </>
            ) : (
              <button onClick={toggleSidebar} className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }} title="Ouvrir (Ctrl+B)">
                <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-primary)' }} />
              </button>
            )}
          </div>

          {!isSidebarCollapsed && (
            <>
              <div className="px-3 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    placeholder={t('chat.search')} className="flex-1 bg-transparent text-sm placeholder-[#555] outline-none" style={{ color: 'var(--text-primary)' }} />
                </div>
              </div>

              {/* Tabs: Chats / Automata */}
              <div className="px-3 pt-2 pb-1 flex gap-1">
                <button onClick={() => { setSidebarTab('chats'); setActiveAutomataTaskId(null) }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  style={sidebarTab === 'chats'
                    ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' }}>
                  <MessageSquare className="w-3 h-3" /> Chats
                </button>
                <button onClick={() => setSidebarTab('automata')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  style={sidebarTab === 'automata'
                    ? { background: 'color-mix(in srgb, var(--scarlet) 14%, transparent)', color: 'var(--accent-primary-light)', border: '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)' }
                    : { background: 'transparent', color: 'var(--text-muted)', border: '1px solid transparent' }}>
                  <Calendar className="w-3 h-3" /> Automata
                </button>
              </div>

              <div className="flex-1 overflow-y-auto py-2" style={{ display: sidebarTab === 'chats' ? undefined : 'none' }}>
                {/* Dossiers */}
                <div className="px-3 py-1 mb-1 flex items-center justify-between">
                  <button onClick={toggleFoldersCollapsed}
                    className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest transition-colors"
                    style={{ color: 'var(--text-muted)' }} title={foldersCollapsed ? 'Déplier' : 'Replier'}>
                    <ChevronRight className="w-3 h-3 transition-transform" style={{ transform: foldersCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }} />
                    Dossiers
                    {folders.length > 0 && <span className="ml-1 normal-case tracking-normal">({folders.length})</span>}
                  </button>
                  <button onClick={handleCreateFolder} className="p-0.5 rounded transition-colors" title="Nouveau dossier" style={{ color: 'var(--text-muted)' }}>
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
                <div className="px-2 mb-2 space-y-0.5" style={{ display: foldersCollapsed ? 'none' : undefined }}>
                  <button onClick={() => setFolderFilter('all')}
                    className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors"
                    style={{ background: folderFilter === 'all' ? 'var(--bg-elevated)' : undefined, color: folderFilter === 'all' ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    <MessageSquare className="w-3 h-3" /> Toutes
                    <span className="ml-auto text-[9px]">{conversations.length}</span>
                  </button>
                  <div
                    onDragEnter={(e) => { e.preventDefault() }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropTargetFolder !== 'none') setDropTargetFolder('none') }}
                    onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTargetFolder(undefined) }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const id = draggedConvoRef.current ?? (Number(e.dataTransfer.getData('text/plain')) || null); if (id !== null) handleDropOnFolder(id, null); draggedConvoRef.current = null; setDropTargetFolder(undefined); setDraggedConvoId(null) }}
                    onClick={() => setFolderFilter(null)}
                    role="button"
                    className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors cursor-pointer"
                    style={{
                      background: dropTargetFolder === 'none' ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : folderFilter === null ? 'var(--bg-elevated)' : undefined,
                      border: dropTargetFolder === 'none' ? '1px dashed var(--accent-primary)' : '1px solid transparent',
                      color: folderFilter === null ? 'var(--text-primary)' : 'var(--text-muted)'
                    }}>
                    <FolderMinus className="w-3 h-3 pointer-events-none" /> <span className="pointer-events-none">Sans dossier</span>
                  </div>
                  {folders.map(f => {
                    const isDropTarget = dropTargetFolder === f.id
                    return (
                      <div key={f.id} className="group/folder flex items-center">
                        <div
                          onDragEnter={(e) => { e.preventDefault() }}
                          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dropTargetFolder !== f.id) setDropTargetFolder(f.id) }}
                          onDragLeave={(e) => { if (e.currentTarget === e.target) setDropTargetFolder(undefined) }}
                          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const id = draggedConvoRef.current ?? (Number(e.dataTransfer.getData('text/plain')) || null); if (id !== null) handleDropOnFolder(id, f.id); draggedConvoRef.current = null; setDropTargetFolder(undefined); setDraggedConvoId(null) }}
                          onClick={() => setFolderFilter(f.id)}
                          role="button"
                          className="flex-1 flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors min-w-0 cursor-pointer"
                          style={{
                            background: isDropTarget ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : folderFilter === f.id ? 'var(--bg-elevated)' : undefined,
                            border: isDropTarget ? '1px dashed var(--accent-primary)' : '1px solid transparent',
                            color: folderFilter === f.id ? 'var(--text-primary)' : 'var(--text-muted)'
                          }}>
                          <Folder className="w-3 h-3 flex-shrink-0 pointer-events-none" style={{ color: f.color || 'var(--accent-primary)' }} />
                          <span className="truncate pointer-events-none">{f.name}</span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(f.id) }}
                          className="opacity-0 group-hover/folder:opacity-100 px-1 transition-opacity" title="Supprimer"
                          style={{ color: 'var(--text-muted)' }}>
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )
                  })}
                </div>

                <div className="px-3 py-1 mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Conversations</span>
                </div>
                {filteredConversations.map(convo => {
                  const isActive = currentConversation === convo.id
                  const isEditing = editingTitleId === convo.id
                  const isDragging = draggedConvoId === convo.id
                  return (
                    <div key={convo.id} onClick={() => !isEditing && setCurrentConversation(convo.id)}
                      draggable={!isEditing}
                      onDragStart={(e) => { draggedConvoRef.current = convo.id; setDraggedConvoId(convo.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(convo.id)) }}
                      onDragEnd={() => { draggedConvoRef.current = null; setDraggedConvoId(null); setDropTargetFolder(undefined) }}
                      className="group mx-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all mb-0.5 flex items-center justify-between"
                      style={{
                        background: isEditing ? 'var(--border)' : isActive ? 'var(--bg-elevated)' : undefined,
                        border: isEditing ? '1px solid var(--border)' : undefined,
                        opacity: isDragging ? 0.4 : 1,
                      }}>
                      <div className="flex-1 min-w-0">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <input type="text" value={editTitleValue} onChange={e => setEditTitleValue(e.target.value)}
                              className="flex-1 text-sm rounded px-2 py-1 outline-none" autoFocus
                              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => { if (e.key === 'Enter') handleSaveTitle(convo.id); if (e.key === 'Escape') handleCancelEdit() }} />
                            <button onClick={(e) => { e.stopPropagation(); handleSaveTitle(convo.id) }} className="p-0.5" style={{ color: 'var(--accent-success)' }}><Check className="w-3 h-3" /></button>
                            <button onClick={(e) => { e.stopPropagation(); handleCancelEdit() }} className="p-0.5" style={{ color: 'var(--accent-primary)' }}><X className="w-3 h-3" /></button>
                          </div>
                        ) : (
                          <>
                            <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{convo.title}</div>
                            <div className="text-xs truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{formatModelName(convo.model)}</div>
                          </>
                        )}
                      </div>
                      {!isEditing && (
                        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                          {/* Bouton Pin — toujours visible si épinglée, sinon
                              révélé au hover sur la ligne (group-hover) pour
                              ne pas surcharger visuellement la sidebar. */}
                          <button
                            onClick={(e) => { e.stopPropagation(); togglePinConversation(convo.id, !!(convo as any).is_pinned) }}
                            className={`p-1 rounded transition-opacity ${(convo as any).is_pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                            style={{ color: (convo as any).is_pinned ? 'var(--scarlet)' : 'var(--text-muted)' }}
                            title={(convo as any).is_pinned ? 'Désépingler' : 'Épingler en haut'}
                          >
                            {(convo as any).is_pinned
                              ? <Pin className="w-3 h-3" fill="currentColor" />
                              : <Pin className="w-3 h-3" />}
                          </button>
                          <ConversationMenu conversationId={convo.id} conversationTitle={convo.title}
                            provider={selectedProvider} model={selectedModel}
                            onTitleUpdated={(id, title) => setConversations(conversations.map(c => c.id === id ? { ...c, title } : c))}
                            onDelete={(id) => handleDeleteConversation(id, true)}
                            onStartEdit={() => handleStartEditing(convo)}
                            onNewChatWithSummary={handleNewChatWithSummary}
                            onFolderChanged={reloadConversations} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Automata tab: task list */}
              <div className="flex-1 overflow-y-auto py-2" style={{ display: sidebarTab === 'automata' ? undefined : 'none' }}>
                <div className="px-3 py-1 mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Tâches planifiées</span>
                  <button onClick={loadAutomataTasks} title="Rafraîchir"
                    className="p-0.5 rounded transition-colors" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ fontSize: 11 }}>↻</span>
                  </button>
                </div>
                {automataTasks.length === 0 ? (
                  <div className="mx-3 mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Aucune tâche encore. Va sur la page Automata ou demande à l'agent d'en créer une.
                  </div>
                ) : (
                  automataTasks.map(task => {
                    const isActive = activeAutomataTaskId === task.id
                    const schedule = task.task_type === 'cron' ? task.cron_expression
                      : task.task_type === 'interval' ? `toutes les ${task.interval_seconds}s`
                      : task.run_at || '—'
                    return (
                      <div key={task.id} onClick={() => setActiveAutomataTaskId(task.id)}
                        className="mx-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all mb-0.5"
                        style={{
                          background: isActive ? 'color-mix(in srgb, var(--scarlet) 14%, transparent)' : undefined,
                          border: isActive ? '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)' : '1px solid transparent',
                        }}>
                        <div className="flex items-center gap-2">
                          <Calendar className="w-3.5 h-3.5 flex-shrink-0" style={{ color: task.enabled ? 'var(--accent-primary-light)' : 'var(--text-muted)' }} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{task.name}</div>
                            <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {schedule} · {task.run_count || 0} run{(task.run_count || 0) > 1 ? 's' : ''}
                            </div>
                          </div>
                          {!task.enabled && <Pause className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="p-3 space-y-1" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center justify-between text-xs px-1" style={{ color: 'var(--text-muted)' }}>
                  <span>{t('chat.tokensUsed')}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{stats.tokens > 999 ? `${(stats.tokens/1000).toFixed(1)}K` : stats.tokens}</span>
                </div>
                <div className="flex items-center justify-between text-xs px-1" style={{ color: 'var(--text-muted)' }}>
                  <span>{t('chat.sessionCost')}</span>
                  <span style={{ color: 'var(--accent-success)' }}>{formatCost(stats.cost)}</span>
                </div>
              </div>
            </>
          )}

          {isSidebarCollapsed && (
            <div className="flex-1 flex flex-col items-center justify-center py-4">
              <button onClick={handleNewChat} className="w-10 h-10 rounded-lg flex items-center justify-center transition-colors"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)' }} title={t('chat.newChat')}>
                <Plus className="w-5 h-5" />
              </button>
              <div className="mt-8 space-y-3">
                {filteredConversations.slice(0, 3).map(convo => {
                  const initial = convo.title.charAt(0).toUpperCase() || '?'
                  return (
                    <button key={convo.id} onClick={() => setCurrentConversation(convo.id)} title={convo.title}
                      className="w-10 h-10 rounded-lg flex items-center justify-center font-medium text-sm transition-all"
                      style={currentConversation === convo.id
                        ? { background: 'linear-gradient(to right, var(--scarlet), var(--ember))', color: 'var(--text-primary)' }
                        : { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                      {initial}
                    </button>
                  )
                })}
              </div>
              <div className="mt-auto mb-4">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: 'linear-gradient(to right, var(--scarlet), var(--ember))' }} />
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── MAIN CHAT ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3" style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <AgentIcon size={14} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{formatModelName(selectedModel)}</span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent)' }}>
              {selectedProvider}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Personality dropdown */}
            <div className="relative">
              <button onClick={() => setShowPersonaMenu(!showPersonaMenu)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                <Bot className="w-3.5 h-3.5" /><span className="capitalize">{activePersonality}</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showPersonaMenu ? 'rotate-180' : ''}`} />
              </button>
              {showPersonaMenu && (
                <div className="absolute top-full right-0 mt-1 w-56 rounded-xl shadow-2xl z-50 p-1.5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                  <div className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 mb-1" style={{ color: 'var(--text-muted)' }}>Personnalité <span style={{ opacity: 0.5 }}>(glisser pour réordonner)</span></div>
                  {personalities.map((p: any, idx: number) => (
                    <div key={p.name}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)) }}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                      onDrop={async (e) => {
                        e.preventDefault()
                        const fromIdx = Number(e.dataTransfer.getData('text/plain'))
                        if (isNaN(fromIdx) || fromIdx === idx) return
                        const reordered = [...personalities]
                        const [moved] = reordered.splice(fromIdx, 1)
                        reordered.splice(idx, 0, moved)
                        setPersonalities(reordered)
                        await api.reorderPersonalities(reordered.map((pp: any) => pp.name))
                      }}
                      onClick={async () => {
                        await api.setPersonality(p.name); setActivePersonality(p.name)
                        setPersonalities(prev => prev.map(pp => ({ ...pp, active: pp.name === p.name }))); setShowPersonaMenu(false)
                      }}
                      className="w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center gap-2 cursor-grab active:cursor-grabbing"
                      style={p.active || p.name === activePersonality
                        ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' }
                        : { color: 'var(--text-secondary)' }}>
                      <GripVertical className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
                      <Bot className="w-3 h-3 flex-shrink-0" /><span className="capitalize">{p.name}</span>
                      <span className="ml-auto text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{p.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <SecondaryButton
              size="sm"
              icon={<Key className="w-3.5 h-3.5" />}
              onClick={() => setShowApiKeysModal(true)}
            >
              {t('common.apiKeys')}
            </SecondaryButton>
            <SecondaryButton
              size="sm"
              icon={currentUser ? (
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                  style={{ background: 'linear-gradient(to bottom right, var(--scarlet), var(--ember))', color: 'var(--text-primary)' }}>
                  {currentUser.display_name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
              ) : <User className="w-3.5 h-3.5" />}
              onClick={() => setShowUserModal(true)}
            >
              {currentUser?.display_name || t('common.user')}
            </SecondaryButton>
          </div>
        </div>

        {/* Automata task view — read-only history shown when a task is picked in the sidebar */}
        {activeAutomataTaskId && activeAutomataTask && (
          <AutomataTaskView
            task={activeAutomataTask}
            history={automataHistory}
            onRefresh={() => loadAutomataHistory(activeAutomataTaskId)}
            onClose={() => setActiveAutomataTaskId(null)}
            onToggle={async () => {
              const token = localStorage.getItem('gungnir_auth_token')
              const headers: Record<string, string> = { 'Content-Type': 'application/json' }
              if (token) headers['Authorization'] = `Bearer ${token}`
              await fetch(`/api/plugins/scheduler/tasks/${activeAutomataTaskId}/toggle`, { method: 'POST', headers })
              loadAutomataTasks()
            }}
            onRunNow={async () => {
              const token = localStorage.getItem('gungnir_auth_token')
              const headers: Record<string, string> = { 'Content-Type': 'application/json' }
              if (token) headers['Authorization'] = `Bearer ${token}`
              await fetch(`/api/plugins/scheduler/tasks/${activeAutomataTaskId}/run`, { method: 'POST', headers })
              setTimeout(() => loadAutomataHistory(activeAutomataTaskId), 1500)
            }}
          />
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-4" style={{ display: activeAutomataTaskId ? 'none' : undefined }}>
          {messages.length === 0 && onboardingState && onboardingState.step !== 'done' && !onboardingState.has_api_key && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl mb-5 flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 18%, transparent), color-mix(in srgb, var(--ember) 12%, transparent))' }}>
                <AgentIcon size={32} />
              </div>
              <h3 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Bienvenue sur Gungnir&nbsp;👋</h3>
              <p className="text-sm max-w-md mb-6" style={{ color: 'var(--text-secondary)' }}>
                Avant qu'on puisse vraiment discuter, il me faut <strong>une clé API</strong> pour te parler. Ça prend 2 minutes : tu choisis un provider (OpenRouter est le plus simple), tu colles ta clé, tu reviens ici et on fait connaissance.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => navigate('/settings?tab=providers')}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                  style={{
                    background: 'linear-gradient(135deg, var(--scarlet), var(--ember))',
                    color: '#fff',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 40%, transparent)',
                  }}
                >
                  Configurer ma clé API →
                </button>
                <button
                  onClick={skipOnboarding}
                  className="px-4 py-2 rounded-xl text-xs transition-colors hover:opacity-80"
                  style={{ color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border)' }}
                >
                  Passer l'onboarding
                </button>
              </div>
              <p className="text-[10px] mt-5 max-w-md" style={{ color: 'var(--text-muted)' }}>
                Une fois la clé configurée, reviens ici : un chat de bienvenue s'ouvrira automatiquement pour que tu puisses me façonner (mon nom, ma personnalité, ta préférence de tutoiement, etc.).
              </p>
            </div>
          )}

          {messages.length === 0 && (!onboardingState || onboardingState.step === 'done' || onboardingState.has_api_key) && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              {/* Logo plus imposant pour asseoir l'identité du produit */}
              <div className="w-24 h-24 rounded-3xl mb-6 flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 18%, transparent), color-mix(in srgb, var(--ember) 12%, transparent))', boxShadow: '0 4px 24px color-mix(in srgb, var(--scarlet) 15%, transparent)' }}>
                <AgentIcon size={52} />
              </div>
              <h3 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('chat.helpIntro')}</h3>
              <p className="text-sm max-w-md mb-8" style={{ color: 'var(--text-muted)' }}>{agentName}{t('chat.helpDesc')}</p>
              {/* Grille 2x2 de suggestions étoffées (titre + description + icône) */}
              <div className="grid grid-cols-2 gap-3 w-full max-w-xl px-4">
                {[
                  { icon: Code, title: t('chat.codeHelp'), desc: t('chat.codeHelpDesc') },
                  { icon: Sparkles, title: t('chat.explainConcept'), desc: t('chat.explainConceptDesc') },
                  { icon: FileText, title: t('chat.writeText'), desc: t('chat.writeTextDesc') },
                  { icon: BarChart3, title: t('chat.analyzeData'), desc: t('chat.analyzeDataDesc') },
                ].map(({ icon: Icon, title, desc }, i) => (
                  <button key={i} onClick={() => setInput(title)}
                    className="group flex flex-col items-start text-left p-3.5 rounded-xl transition-all hover:-translate-y-0.5"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--scarlet) 40%, transparent)'; e.currentTarget.style.background = 'color-mix(in srgb, var(--scarlet) 5%, var(--bg-secondary))' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-secondary)' }}>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center mb-2"
                      style={{ background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)', color: 'var(--scarlet)' }}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{title}</div>
                    <div className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>{desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, msgIdx) => (
            <div key={msg.id} className={`flex gap-3 animate-fade-in ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
              {msg.role === 'assistant' ? (
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 10%, var(--bg-primary)), color-mix(in srgb, var(--scarlet) 15%, var(--bg-primary)))', border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)' }}>
                  <AgentIcon size={14} />
                </div>
              ) : currentUser?.avatar_url ? (
                <img src={currentUser.avatar_url} alt={currentUser.display_name || 'User'} className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5 object-cover" style={{ border: '1px solid var(--border)' }} />
              ) : (
                <div className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center text-xs font-bold"
                  style={{ background: 'linear-gradient(to bottom right, var(--scarlet), var(--ember))', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
                  {currentUser?.display_name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
              )}

              <div className="flex flex-col gap-1 max-w-[70%] items-stretch">
                {/* Header : pseudo + provider + compteur tokens (au-dessus de la bulle, pas accolé) */}
                {(() => {
                  // Tokens : assistant → tokens_output propres ; user → tokens_input
                  // de la bulle assistant qui suit (c'est ce que le prompt a consommé).
                  let headerTokens: number | undefined
                  if (msg.role === 'assistant') {
                    headerTokens = (msg as any).tokens_output
                  } else {
                    const next = messages[msgIdx + 1]
                    if (next && next.role === 'assistant') headerTokens = (next as any).tokens_input
                  }
                  const hasTokens = typeof headerTokens === 'number' && headerTokens > 0
                  // Pseudo + provider groupés d'un côté de la ligne ; tokens
                  // placés du côté opposé (justify-between). Assistant : pseudo
                  // à gauche, tokens à droite. User : pseudo à droite, tokens
                  // à gauche. Sans tokens, le pseudo reste simplement aligné
                  // sur son bord habituel.
                  return (
                    <div className={`flex items-center self-stretch gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} ${hasTokens ? 'justify-between' : ''}`}>
                      <div className={`flex items-center gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                          {msg.role === 'user' ? (currentUser?.display_name || t('common.user')) : formatModelName((msg as any).model || selectedModel)}
                        </span>
                        {msg.role === 'assistant' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
                            style={{ background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)', color: 'var(--accent-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>
                            {(msg as any).provider || selectedProvider}
                          </span>
                        )}
                      </div>
                      {hasTokens && <TokenBadge tokens={headerTokens as number} />}
                    </div>
                  )
                })()}

                {msg.role === 'assistant' && (msg as any).tool_events?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1 self-start">
                    {(msg as any).tool_events.map((evt: any, i: number) => {
                      // Permission card : affichée quand le backend a gating
                      // l'outil en mode "Restreint" (tool_event marqué avec
                      // result.pending_approval = true — style Claude Code).
                      // Le mode "Demande" fait une validation chat pure, sans
                      // pending_approval, donc pas de carte ici.
                      if (evt.result?.pending_approval) {
                        return (
                          <PermissionCard key={i}
                            toolName={evt.result?.tool_name || evt.tool}
                            args={evt.result?.args || evt.args}
                            permissionId={evt.result?.permission_id}
                            onApprove={async () => {
                              const tn = evt.result?.tool_name || evt.tool
                              const argsJson = JSON.stringify(evt.result?.args ?? evt.args ?? {})
                              try {
                                await apiFetch(`/api/agent/permission/${evt.result.permission_id}/approve`, { method: 'POST' })
                              } catch { /* ignore */ }
                              // Message explicite pour pousser l'agent à re-exécuter l'outil au tour suivant avec les MÊMES args + annoncer le résultat dans le chat.
                              handleSend(`Autorisation accordée. Exécute maintenant \`${tn}\` avec les arguments ${argsJson}, puis dis-moi ce que ça a donné.`)
                            }}
                            onDeny={async () => {
                              const tn = evt.result?.tool_name || evt.tool
                              try {
                                await apiFetch(`/api/agent/permission/${evt.result.permission_id}/deny`, { method: 'POST' })
                              } catch { /* ignore */ }
                              handleSend(`Refusé. N'exécute pas \`${tn}\`. Propose une alternative ou demande-moi des précisions.`)
                            }}
                          />
                        )
                      }
                      return (
                        <div key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                          style={{
                            background: evt.result?.ok !== false ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
                            border: `1px solid ${evt.result?.ok !== false ? 'color-mix(in srgb, var(--accent-success) 20%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 20%, transparent)'}`,
                            color: evt.result?.ok !== false ? 'var(--accent-success)' : 'var(--accent-danger, var(--accent-primary-light))',
                          }}>
                          <Sparkles className="w-2.5 h-2.5 flex-shrink-0" /><span>{evt.tool}</span>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className={`group relative rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user' ? 'rounded-tr-sm self-end' : 'rounded-tl-sm self-start'}`}
                  style={msg.role === 'assistant' ? {
                    background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 4%, transparent), color-mix(in srgb, var(--ember) 2%, transparent))',
                    border: '1px solid color-mix(in srgb, var(--scarlet) 10%, transparent)', color: 'var(--text-primary)',
                  } : { background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <FloatingCopyButton
                    content={msg.content.replace(/\n\[Image jointe\]/g, '')}
                    side={msg.role === 'user' ? 'left' : 'right'}
                  />
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {msg.images.map((img: string, i: number) => (
                        <img key={i} src={img} alt={`Image ${i + 1}`} className="max-h-48 rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setLightboxSrc(img)} />
                      ))}
                    </div>
                  )}
                  {/* Images GÉNÉRÉES par l'assistant (DALL-E, Imagen, NanoBanana…) */}
                  {(msg as any).images_out && Array.isArray((msg as any).images_out) && (msg as any).images_out.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {(msg as any).images_out.map((img: any, i: number) => {
                        const src = img.url || (img.b64 ? `data:${img.mime_type || 'image/png'};base64,${img.b64}` : null)
                        if (!src) return null
                        return (
                          <div key={i} className="flex flex-col gap-1">
                            <img src={src} alt={`Image générée ${i + 1}`}
                              className="max-h-80 rounded-lg border border-[var(--border)] cursor-pointer hover:opacity-90 transition-opacity"
                              style={{ maxWidth: '100%' }}
                              onClick={() => setLightboxSrc(src)} />
                            {img.revised_prompt && (
                              <span className="text-[10px] italic" style={{ color: 'var(--text-muted)', maxWidth: 360 }}>
                                « {img.revised_prompt} »
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <MessageContent content={msg.content.replace(/\n\[Image jointe\]/g, '')} />
                </div>
                {/* Barre d'actions (copie + régénération + 👍/👎) */}
                {msg.content && (
                  <MessageActions
                    role={msg.role as 'user' | 'assistant'}
                    content={msg.content.replace(/\n\[Image jointe\]/g, '')}
                    onRegenerate={() => regenerateResponse(msg.id)}
                    canRegenerate={!isLoading}
                    onScore={msg.role === 'assistant' ? (v) => scoreResponse(msg.id, v) : undefined}
                  />
                )}
              </div>
            </div>
          ))}

          {loadingConvoId !== null && loadingConvoId === currentConversation && (
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 10%, var(--bg-primary)), color-mix(in srgb, var(--scarlet) 15%, var(--bg-primary)))', border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)' }}>
                <AgentIcon size={14} />
              </div>
              <div className="rounded-2xl px-4 py-3 text-sm rounded-tl-sm"
                style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--scarlet) 4%, transparent), color-mix(in srgb, var(--ember) 2%, transparent))', border: '1px solid color-mix(in srgb, var(--scarlet) 10%, transparent)' }}>
                <div className="flex gap-1.5">
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'color-mix(in srgb, var(--accent-primary) 60%, transparent)', animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'color-mix(in srgb, var(--accent-primary) 60%, transparent)', animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full animate-bounce" style={{ background: 'color-mix(in srgb, var(--accent-primary) 60%, transparent)', animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area — nouvelle boîte unifiée (header + textarea + footer) */}
        <div className="px-5 py-4 relative" style={{ background: 'var(--bg-primary)', borderTop: '1px solid var(--border-subtle)', display: activeAutomataTaskId ? 'none' : undefined }}
          onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          {isDraggingFiles && (
            <div className="absolute inset-2 rounded-2xl flex items-center justify-center pointer-events-none z-10"
              style={{
                background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                border: '2px dashed var(--accent-primary)',
                color: 'var(--accent-primary)',
              }}>
              <div className="flex flex-col items-center gap-2">
                <Paperclip className="w-6 h-6" />
                <span className="text-sm font-medium">Déposez vos fichiers ici</span>
              </div>
            </div>
          )}
          <div className="max-w-4xl mx-auto">
            {/* Aperçu fichiers joints (au-dessus de la boîte) */}
            {attachedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {attachedFiles.map((f, i) => (
                  <div key={i} className="relative group rounded-lg overflow-hidden border border-[var(--border)]"
                    style={{ background: 'var(--bg-secondary)' }}>
                    {f.preview ? (
                      <img src={f.preview} alt={f.name} className="h-16 w-16 object-cover" />
                    ) : (
                      <div className="h-16 w-16 flex items-center justify-center">
                        <FileText className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                      <span className="text-[8px] text-white truncate block">{f.name}</span>
                    </div>
                    <button onClick={() => removeAttachment(i)}
                      className="absolute top-0 right-0 p-0.5 bg-black/60 rounded-bl opacity-0 group-hover:opacity-100 transition-opacity">
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Boîte de saisie */}
            <div className="rounded-2xl"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>

              {/* Textarea transparent à l'intérieur de la boîte */}
              <div className="px-3 pt-3 pb-2">
                <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder={t('chat.placeholder')} rows={1}
                  className="w-full bg-transparent text-sm placeholder-[#555] outline-none resize-none"
                  style={{ color: 'var(--text-primary)', minHeight: '36px', maxHeight: '200px' }}
                  onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px' }} />
              </div>

              {/* Barre d'actions unifiée — ordre : [Modèle] [Skills] [📎] [🖼️]
                  [Skill actif chip?] [Hint /] ...(ml-auto) [Tokens?] [Wand] [Mic]
                  [TTS] [Radio] [Lancer/Stop]. Une seule ligne, alignée sur la
                  concurrence (ChatGPT/Claude). */}
              <div className="flex items-center gap-1.5 px-2 pb-2">
                {/* 1) Sélecteur de modèle */}
                <div className="relative">
                  <button onClick={() => setShowModelMenu(!showModelMenu)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors whitespace-nowrap"
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                    <AgentIcon size={11} /><span>{formatModelName(selectedModel)}</span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
                  </button>
                  {showModelMenu && (
                    <div className="absolute bottom-full left-0 mb-2 w-80 rounded-xl shadow-2xl z-50 max-h-80 flex flex-col"
                      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                      <div className="p-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <input type="text" value={modelSearch} onChange={e => setModelSearch(e.target.value)}
                          placeholder="Rechercher un modèle..." className="w-full rounded-lg px-3 py-1.5 text-xs placeholder-[#555] outline-none"
                          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                      </div>
                      <div className="overflow-y-auto p-1.5">
                        {favoriteModels.length > 0 && !modelSearch.trim() && (
                          <div className="mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-widest flex items-center gap-1" style={{ color: 'var(--accent-tertiary)' }}>
                              <Star className="w-2.5 h-2.5" /> Favoris
                            </div>
                            {favoriteModels.map(fav => {
                              const [prov, mod] = fav.split('::')
                              return (
                                <button key={fav} onClick={() => { setSelectedModel(mod); setSelectedProvider(prov); setShowModelMenu(false); setModelSearch('') }}
                                  className="w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between"
                                  style={selectedModel === mod && selectedProvider === prov ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' } : { color: 'var(--text-secondary)' }}>
                                  <span className="truncate">{mod.split('/').pop()} <span style={{ color: 'var(--text-muted)' }}>({prov})</span></span>
                                  <Star className="w-3 h-3 flex-shrink-0 fill-current" style={{ color: 'var(--accent-tertiary)' }}
                                    onClick={e => { e.stopPropagation(); toggleFavorite(prov, mod) }} />
                                </button>
                              )
                            })}
                          </div>
                        )}
                        {groupedProviders.map(group => {
                          const limit = group.models.length
                          const displayModels = group.models.slice(0, limit)
                          const hasMore = group.models.length > limit
                          return (
                            <div key={group.name}>
                              <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-widest flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
                                <span>{group.name}</span>
                                <span className="text-[8px] font-normal">{group.models.length}</span>
                              </div>
                              {displayModels.map(m => {
                                const isFav = favoriteModels.includes(`${group.name}::${m}`)
                                return (
                                  <button key={m} onClick={() => { setSelectedModel(m); setSelectedProvider(group.name); setShowModelMenu(false); setModelSearch('') }}
                                    className="w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors flex items-center justify-between group"
                                    style={selectedModel === m ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-primary-light)' } : { color: 'var(--text-secondary)' }}>
                                    <span className="truncate">{m}</span>
                                    <Star className={`w-3 h-3 flex-shrink-0 cursor-pointer transition-colors ${isFav ? 'fill-current' : ''}`}
                                      style={{ color: isFav ? 'var(--accent-tertiary)' : 'var(--border)' }}
                                      onClick={e => { e.stopPropagation(); toggleFavorite(group.name, m) }} />
                                  </button>
                                )
                              })}
                              {hasMore && (
                                <button onClick={() => setExpandedProviders(prev => { const next = new Set(prev); next.add(group.name); return next })}
                                  className="w-full text-center py-1.5 text-[10px] transition-colors rounded-lg"
                                  style={{ color: 'var(--accent-primary)' }}>
                                  + {group.models.length - limit} modèles...
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* 2) Bouton Skills (toggle) */}
                {allSkills.length > 0 && (
                  <button onClick={() => setShowSkillsBar(!showSkillsBar)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] transition-colors"
                    style={{
                      background: showSkillsBar ? 'color-mix(in srgb, var(--accent-tertiary) 18%, transparent)' : 'var(--bg-tertiary)',
                      border: `1px solid ${showSkillsBar ? 'color-mix(in srgb, var(--accent-tertiary) 40%, transparent)' : 'var(--border)'}`,
                      color: showSkillsBar ? 'var(--accent-tertiary)' : 'var(--text-secondary)',
                    }}
                    title="Afficher / masquer les skills">
                    <Sparkles className="w-3 h-3" />
                    <span>Skills</span>
                  </button>
                )}

                {/* 3) Trombone — pièce jointe fichier */}
                <input ref={fileInputRef} type="file" multiple accept="image/*,.txt,.md,.json,.csv,.xml,.html,.py,.js,.ts,.tsx,.jsx,.css,.yaml,.yml,.log,.sql,.sh,.bat" className="hidden"
                  onChange={handleFileSelect} />
                <button onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center rounded-lg transition-colors"
                  style={{ width: '26px', height: '26px', background: attachedFiles.length > 0 ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'transparent', border: `1px solid ${attachedFiles.length > 0 ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'var(--border)'}`, color: attachedFiles.length > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                  title={t('chat.attachFile')}>
                  <Paperclip className="w-3 h-3" />
                </button>

                {/* 4) Génération d'image — ouvre la modal de sélection */}
                <button
                  onClick={() => {
                    setImgGenPrompt(input.trim() || '')
                    setImgGenError('')
                    setShowImageGenModal(true)
                  }}
                  disabled={imgGenCatalog.length === 0}
                  className="flex items-center justify-center rounded-lg transition-colors"
                  style={{
                    width: '26px', height: '26px',
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: imgGenCatalog.length > 0 ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: imgGenCatalog.length > 0 ? 'pointer' : 'not-allowed',
                    opacity: imgGenCatalog.length > 0 ? 1 : 0.4,
                  }}
                  title={imgGenCatalog.length > 0
                    ? 'Générer une image (DALL-E, Imagen, NanoBanana…)'
                    : 'Aucun provider image configuré (ajoute une clé OpenAI, Google ou OpenRouter)'}>
                  <ImageIcon className="w-3 h-3" />
                </button>

                {/* Skill actif — chip avec × pour désactiver (conditionnel) */}
                {activeSkill && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px]"
                    style={{
                      background: 'color-mix(in srgb, var(--accent-tertiary) 18%, transparent)',
                      border: '1px solid color-mix(in srgb, var(--accent-tertiary) 40%, transparent)',
                      color: 'var(--accent-tertiary)',
                    }}
                    title={`Skill actif : ${activeSkill}`}>
                    <Sparkles className="w-3 h-3" />
                    <span className="truncate max-w-[120px]">{activeSkill.replace(/_/g, ' ')}</span>
                    <button onClick={async () => { await api.clearActiveSkill(); setActiveSkill(null) }}
                      className="hover:opacity-70 transition-opacity" title="Désactiver">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}

                {/* Hint raccourci / */}
                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
                  style={{ color: 'var(--text-muted)' }}
                  title="Tape '/' pour ouvrir la palette">
                  <span className="font-mono opacity-60">/</span>
                </div>

                {/* Tokens session — positionné juste avant la zone d'actions
                    droite (le ml-auto vit sur le bouton Wand qui suit). */}
                {sessionTokens > 0 && (
                  <div className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[10px]"
                    style={{ color: 'var(--text-muted)', background: 'transparent' }}
                    title={`Tokens cumulés dans cette session : ${sessionTokens.toLocaleString()}`}>
                    <Zap className="w-3 h-3" />
                    <span>{sessionTokens.toLocaleString()} tok</span>
                  </div>
                )}
                {/* Spacer transparent quand aucun chip tokens : garantit que
                    le bloc d'actions droit reste poussé à droite même sans
                    ml-auto naturel sur le premier bouton. */}
                {sessionTokens <= 0 && <div className="ml-auto" />}

                {/* Améliorer le prompt — LLM réécrit le draft */}
                <button onClick={improvePrompt}
                  disabled={!input.trim() || improving || isLoading}
                  className="flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  style={improving
                    ? { width: '30px', height: '30px', background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent)', color: 'var(--accent-primary)' }
                    : originalBeforeImprove !== null
                      ? { width: '30px', height: '30px', background: 'color-mix(in srgb, var(--accent-success, #10b981) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-success, #10b981) 30%, transparent)', color: 'var(--accent-success, #10b981)' }
                      : { width: '30px', height: '30px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  title={originalBeforeImprove !== null
                    ? 'Prompt amélioré — Escape pour annuler'
                    : 'Améliorer le prompt (LLM reformule le draft)'}>
                  {improving
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Wand2 className="w-3.5 h-3.5" />}
                </button>

                {/* Mic PTT */}
                <button onClick={() => pttStatus === 'recording' ? stopPTT() : startPTT()}
                  className="flex items-center justify-center rounded-lg transition-colors"
                  style={pttStatus === 'recording'
                    ? { width: '30px', height: '30px', background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent)', color: 'var(--accent-primary)' }
                    : { width: '30px', height: '30px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  title={t('chat.speak')}>
                  {pttStatus === 'recording' ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                </button>

                {/* TTS toggle — lit les réponses LLM à voix haute via Web Speech API */}
                <button onClick={toggleTts}
                  className="flex items-center justify-center rounded-lg transition-colors"
                  style={ttsEnabled
                    ? { width: '30px', height: '30px', background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent)', color: 'var(--accent-primary)' }
                    : { width: '30px', height: '30px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  title={ttsEnabled
                    ? (ttsSpeaking ? 'Lecture en cours — cliquer pour couper' : 'Lecture vocale activée')
                    : 'Activer la lecture vocale des réponses'}>
                  {ttsEnabled
                    ? <Volume2 className={`w-3.5 h-3.5 ${ttsSpeaking ? 'animate-pulse' : ''}`} />
                    : <VolumeX className="w-3.5 h-3.5" />}
                </button>

                {/* Voice modal (realtime) */}
                <button onClick={() => setShowVoiceModal(true)} className="flex items-center justify-center rounded-lg transition-colors"
                  style={showVoiceModal
                    ? { width: '30px', height: '30px', background: 'color-mix(in srgb, var(--accent-primary) 20%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, transparent)', color: 'var(--accent-primary)' }
                    : { width: '30px', height: '30px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
                  title={t('chat.realtime')}>
                  <Radio className="w-3.5 h-3.5" />
                </button>

                {/* Bouton Lancer (envoyer) / Stop (pendant génération) */}
                {isLoading ? (
                  <button onClick={() => abortRef.current?.abort()}
                    className="flex items-center gap-1.5 px-3 rounded-lg transition-all text-xs font-medium"
                    style={{ height: '30px', background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))', color: 'var(--text-primary)' }}
                    title="Interrompre la réponse en cours">
                    <Square className="w-3 h-3" fill="currentColor" />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button onClick={() => handleSend()} disabled={(!input.trim() && attachedFiles.length === 0)}
                    className="flex items-center gap-1.5 px-3 rounded-lg disabled:opacity-30 transition-all text-xs font-medium"
                    style={{ height: '30px', background: (input.trim() || attachedFiles.length > 0) ? 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))' : 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                    <Send className="w-3 h-3" />
                    <span>Lancer</span>
                  </button>
                )}
              </div>
            </div>

            {/* Info row sous la boîte */}
            <div className="flex items-center justify-between mt-1.5 px-1 text-[10px]"
              style={{ color: 'var(--text-muted)' }}>
              <span>Gungnir peut exécuter des actions — vérifie les réponses critiques.</span>
              <span>{allSkills.length} skill{allSkills.length > 1 ? 's' : ''}</span>
            </div>

            {/* Skills bar repliable — ne s'affiche que si toggle activé */}
            {showSkillsBar && allSkills.length > 0 && (() => {
              const displaySkills = favoriteSkills.length > 0 ? favoriteSkills : allSkills.slice(0, 6)
              return (
                <div className="flex items-center gap-2 mt-2 overflow-x-auto">
                  <Sparkles className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-tertiary)' }} />
                  {displaySkills.map((skill: any, idx: number) => {
                    const isActive = skill.name === activeSkill
                    return (
                      <div
                        key={skill.name}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)) }}
                        onDragEnter={(e) => e.preventDefault()}
                        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                        onDrop={async (e) => {
                          e.preventDefault()
                          const fromIdx = Number(e.dataTransfer.getData('text/plain'))
                          if (isNaN(fromIdx) || fromIdx === idx) return
                          const reordered = [...allSkills]
                          const fromSkill = displaySkills[fromIdx]
                          const toSkill = displaySkills[idx]
                          const realFrom = reordered.findIndex(s => s.name === fromSkill?.name)
                          let realTo = reordered.findIndex(s => s.name === toSkill?.name)
                          if (realFrom < 0 || realTo < 0 || realFrom === realTo) return
                          const [moved] = reordered.splice(realFrom, 1)
                          if (realFrom < realTo) realTo--
                          reordered.splice(realTo, 0, moved)
                          setAllSkills(reordered)
                          setFavoriteSkills(reordered.filter((sk: any) => sk.is_favorite))
                          await api.reorderSkills(reordered.map((sk: any) => sk.name))
                        }}
                        onClick={async () => {
                          if (isActive) {
                            await api.clearActiveSkill(); setActiveSkill(null)
                          } else {
                            await api.setActiveSkill(skill.name); setActiveSkill(skill.name)
                          }
                        }}
                        role="button"
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] whitespace-nowrap transition-all hover:scale-105 cursor-grab active:cursor-grabbing select-none"
                        style={{
                          background: isActive ? 'color-mix(in srgb, var(--accent-tertiary) 18%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                          border: `1px solid ${isActive ? 'color-mix(in srgb, var(--accent-tertiary) 40%, transparent)' : 'color-mix(in srgb, var(--accent-primary) 20%, transparent)'}`,
                          color: isActive ? 'var(--accent-tertiary)' : 'var(--text-secondary)',
                        }}
                        title={skill.description}
                      >
                        {skill.icon ? <span className="text-sm leading-none">{skill.icon}</span> : <Code className="w-3 h-3" style={{ color: isActive ? 'var(--accent-tertiary)' : 'var(--accent-primary)' }} />}
                        {skill.name.replace(/_/g, ' ')}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>
        </div>
      </div>

      {/* Lightbox fullscreen — image affichée en grand sur clic. Ferme au
          clic de l'overlay OU de la croix OU de la touche Échap. */}
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* Modals */}
      <VoiceModal isOpen={showVoiceModal} onClose={() => setShowVoiceModal(false)} />
      <ApiKeysModal isOpen={showApiKeysModal} onClose={() => setShowApiKeysModal(false)} config={config}
        onConfigUpdate={(newConfig) => useStore.getState().setConfig(newConfig)} />
      <UserModal isOpen={showUserModal} onClose={() => setShowUserModal(false)} currentUser={currentUser} onUserChange={setCurrentUser} />

      {/* Image generation modal — sélection explicite du modèle (DALL-E 3,
          GPT Image 1, Imagen 3, NanoBanana…), pas de détection auto. */}
      {showImageGenModal && (
        <ImageGenEscCloser onClose={() => setShowImageGenModal(false)} />
      )}
      {showImageGenModal && (
        <div
          onClick={() => setShowImageGenModal(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
        >
          <div onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: 560,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 14, padding: 22,
              display: 'flex', flexDirection: 'column', gap: 14,
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ImageIcon className="w-5 h-5" style={{ color: 'var(--scarlet)' }} />
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                Génération d'image
              </h3>
              <div style={{ flex: 1 }} />
              <button onClick={() => setShowImageGenModal(false)}
                title="Fermer (Échap)"
                style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>
                ×
              </button>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Prompt</label>
              <textarea
                value={imgGenPrompt} onChange={(e) => setImgGenPrompt(e.target.value)}
                placeholder="Décris l'image à générer…"
                rows={3}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 13,
                  borderRadius: 6, background: 'var(--bg-primary)',
                  border: '1px solid var(--border)', color: 'var(--text-primary)',
                  outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Provider</label>
                <select
                  value={imgGenProvider}
                  onChange={(e) => {
                    const prov = e.target.value
                    setImgGenProvider(prov)
                    const firstModel = imgGenCatalog.find(p => p.provider === prov)?.models[0]
                    if (firstModel) {
                      setImgGenModel(firstModel.id)
                      setImgGenSize(firstModel.default_size || firstModel.sizes[0] || '1024x1024')
                    }
                  }}
                  style={{
                    width: '100%', padding: '7px 10px', fontSize: 12,
                    borderRadius: 6, background: 'var(--bg-primary)',
                    border: '1px solid var(--border)', color: 'var(--text-primary)',
                  }}>
                  {imgGenCatalog.map(p => (
                    <option key={p.provider} value={p.provider}>{p.provider}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 2 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Modèle</label>
                <select
                  value={imgGenModel}
                  onChange={(e) => {
                    const modelId = e.target.value
                    setImgGenModel(modelId)
                    const modelDef = imgGenCatalog
                      .find(p => p.provider === imgGenProvider)?.models
                      .find(m => m.id === modelId)
                    if (modelDef) setImgGenSize(modelDef.default_size || modelDef.sizes[0] || '1024x1024')
                  }}
                  style={{
                    width: '100%', padding: '7px 10px', fontSize: 12,
                    borderRadius: 6, background: 'var(--bg-primary)',
                    border: '1px solid var(--border)', color: 'var(--text-primary)',
                  }}>
                  {imgGenCatalog.find(p => p.provider === imgGenProvider)?.models.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Taille</label>
              <select
                value={imgGenSize} onChange={(e) => setImgGenSize(e.target.value)}
                style={{
                  width: '100%', padding: '7px 10px', fontSize: 12,
                  borderRadius: 6, background: 'var(--bg-primary)',
                  border: '1px solid var(--border)', color: 'var(--text-primary)',
                }}>
                {(imgGenCatalog.find(p => p.provider === imgGenProvider)?.models
                  .find(m => m.id === imgGenModel)?.sizes || ['1024x1024']).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
              </select>
            </div>

            {imgGenError && (
              <div style={{
                padding: '8px 12px', borderRadius: 6, fontSize: 12,
                background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
                color: 'var(--accent-primary)',
              }}>
                {imgGenError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button
                onClick={() => setShowImageGenModal(false)}
                style={{
                  padding: '8px 16px', borderRadius: 6, fontSize: 13,
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}>
                {imgGenLoading ? 'Fermer (génération en cours)' : 'Annuler'}
              </button>
              <button
                disabled={imgGenLoading || !imgGenPrompt.trim() || !imgGenProvider || !imgGenModel}
                onClick={async () => {
                  setImgGenError('')
                  if (!currentConversation) {
                    setImgGenError("Ouvre ou crée une conversation d'abord.")
                    return
                  }
                  setImgGenLoading(true)
                  try {
                    const res = await apiFetch('/api/chat/image', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        prompt: imgGenPrompt.trim(),
                        provider: imgGenProvider,
                        model: imgGenModel,
                        size: imgGenSize,
                        n: 1,
                        conversation_id: currentConversation,
                      }),
                    })
                    const data = await res.json()
                    if (!data?.ok) {
                      setImgGenError(data?.error || 'Échec de la génération')
                      return
                    }
                    // Recharge les messages pour afficher le nouveau couple user/assistant
                    try {
                      const msgs = await api.getMessages(currentConversation)
                      setMessages(msgs)
                    } catch { /* ignore */ }
                    setShowImageGenModal(false)
                    setImgGenPrompt('')
                  } catch (e: any) {
                    setImgGenError(`Erreur réseau : ${e?.message || 'inconnue'}`)
                  } finally {
                    setImgGenLoading(false)
                  }
                }}
                style={{
                  padding: '8px 20px', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  background: 'var(--scarlet)', border: 'none', color: '#fff',
                  cursor: imgGenLoading ? 'wait' : 'pointer',
                  opacity: (imgGenLoading || !imgGenPrompt.trim()) ? 0.6 : 1,
                }}>
                {imgGenLoading ? 'Génération…' : '✨ Générer'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// Écoute Escape pour fermer une modal — component helper pour éviter du useEffect
// inline dans le gros composant Chat.
function ImageGenEscCloser({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return null
}


// ── Automata task view (read-only history rendered chat-style) ─────────────

function AutomataTaskView({ task, history, onRefresh, onClose, onToggle, onRunNow }: {
  task: any
  history: any[]
  onRefresh: () => void
  onClose: () => void
  onToggle: () => void
  onRunNow: () => void
}) {
  const schedule = task.task_type === 'cron' ? task.cron_expression
    : task.task_type === 'interval' ? `toutes les ${task.interval_seconds}s`
    : task.run_at || '—'

  const fmt = (iso: string | null | undefined) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch { return iso }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-5 py-3 flex items-center justify-between"
        style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'color-mix(in srgb, var(--scarlet) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--scarlet) 25%, transparent)' }}>
            <Calendar className="w-4 h-4" style={{ color: 'var(--accent-primary-light)' }} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{task.name}</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {task.task_type} · {schedule} · {task.run_count || 0} exécution{(task.run_count || 0) > 1 ? 's' : ''}
              {task.enabled ? ' · ACTIF' : ' · EN PAUSE'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={onRunNow} title="Exécuter maintenant"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            <Play className="w-3 h-3" /> Lancer
          </button>
          <button onClick={onToggle} title={task.enabled ? 'Mettre en pause' : 'Activer'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            {task.enabled ? <><Pause className="w-3 h-3" /> Pause</> : <><Play className="w-3 h-3" /> Activer</>}
          </button>
          <button onClick={onRefresh} title="Rafraîchir"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>↻</button>
          <button onClick={onClose} title="Fermer"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-5 py-6 space-y-4">
        {/* Static prompt bubble */}
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
            style={{ background: 'color-mix(in srgb, var(--scarlet) 15%, var(--bg-primary))', border: '1px solid color-mix(in srgb, var(--scarlet) 30%, transparent)' }}>
            <Calendar className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary-light)' }} />
          </div>
          <div className="rounded-2xl px-4 py-3 text-sm rounded-tl-sm max-w-2xl"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
            <div className="text-[10px] font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--text-muted)' }}>Prompt envoyé à chaque exécution</div>
            <div className="whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{task.prompt}</div>
          </div>
        </div>

        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Clock className="w-10 h-10 mb-3" style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Aucune exécution pour le moment.
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {task.enabled ? `Prochaine exécution selon ${schedule}.` : 'La tâche est en pause — active-la pour qu\'elle tourne.'}
            </div>
          </div>
        ) : (
          [...history].reverse().map((entry) => {
            const ok = entry.status === 'success'
            return (
              <div key={entry.id || entry.timestamp} className="flex gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: ok ? 'color-mix(in srgb, var(--accent-success) 12%, var(--bg-primary))' : 'color-mix(in srgb, var(--scarlet) 12%, var(--bg-primary))', border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)' }}>
                  {ok ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-success)' }} />
                      : <AlertCircle className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary-light)' }} />}
                </div>
                <div className="flex-1 min-w-0 max-w-3xl">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                      {fmt(entry.timestamp || entry.triggered_at)}
                    </span>
                    {entry.model && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                        {entry.model}
                      </span>
                    )}
                    {!ok && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold" style={{ background: 'color-mix(in srgb, var(--scarlet) 15%, transparent)', color: 'var(--accent-primary-light)' }}>
                        {entry.status}
                      </span>
                    )}
                  </div>
                  <div className="rounded-2xl px-4 py-3 text-sm rounded-tl-sm"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                    <div className="whitespace-pre-wrap">
                      {entry.response || entry.error || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>(vide)</span>}
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}


// ════════════════════════════════════════════════════════════════════════
// PermissionCard — carte de confirmation pour le mode ask_permission.
// Affichée quand le backend a bloqué un tool d'écriture et demande l'aval
// de l'user. Deux boutons : Autoriser / Refuser. En cliquant, on appelle
// l'endpoint existant (/api/agent/permission/:id/approve|deny) + on envoie
// un message "Oui/Non" qui relance la convo → le backend détecte le
// keyword et exécute le tool au tour suivant.
// Cohabite avec le canal text-only (Telegram etc.) : le LLM produit aussi
// une question texte, donc un user qui ne voit pas les boutons peut
// toujours répondre "oui" en texte.
// ════════════════════════════════════════════════════════════════════════

function PermissionCard({
  toolName, args, permissionId, onApprove, onDeny,
}: {
  toolName: string
  args: any
  permissionId?: string
  onApprove: () => void
  onDeny: () => void
}) {
  const [state, setState] = useState<'pending' | 'approved' | 'denied'>('pending')
  const argsPreview = (() => {
    try {
      const s = JSON.stringify(args ?? {}, null, 2)
      return s.length > 320 ? s.slice(0, 320) + '…' : s
    } catch { return String(args) }
  })()
  if (state !== 'pending') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px]"
        style={{
          background: state === 'approved'
            ? 'color-mix(in srgb, var(--accent-success) 8%, transparent)'
            : 'color-mix(in srgb, var(--accent-danger, var(--accent-primary)) 8%, transparent)',
          border: `1px solid ${state === 'approved'
            ? 'color-mix(in srgb, var(--accent-success) 30%, transparent)'
            : 'color-mix(in srgb, var(--accent-danger, var(--accent-primary)) 30%, transparent)'}`,
          color: state === 'approved' ? 'var(--accent-success)' : 'var(--accent-danger, var(--accent-primary-light))',
        }}>
        {state === 'approved' ? <ShieldCheck className="w-3 h-3" /> : <ShieldAlert className="w-3 h-3" />}
        <span style={{ fontWeight: 600 }}>{toolName}</span>
        <span style={{ opacity: 0.7 }}>
          {state === 'approved' ? 'autorisé' : 'refusé'}
        </span>
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8,
      width: '100%', padding: 12, borderRadius: 10,
      background: 'color-mix(in srgb, var(--scarlet) 6%, var(--bg-secondary))',
      border: '1px solid color-mix(in srgb, var(--scarlet) 35%, var(--border))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldAlert className="w-4 h-4" style={{ color: 'var(--scarlet)' }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          Confirmation requise
        </span>
        <span style={{
          fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
          padding: '1px 6px', borderRadius: 4,
          background: 'var(--bg-primary)', color: 'var(--scarlet)',
        }}>
          {toolName}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        L'agent demande à exécuter cet outil. Vérifie les paramètres puis autorise ou refuse.
      </div>
      {args && Object.keys(args).length > 0 && (
        <details>
          <summary style={{
            fontSize: 10.5, color: 'var(--text-muted)', cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: 1.5,
          }}>
            Paramètres
          </summary>
          <pre style={{
            marginTop: 6, padding: 8, borderRadius: 6,
            background: 'var(--bg-primary)', border: '1px solid var(--border)',
            fontSize: 11, color: 'var(--text-secondary)',
            fontFamily: 'JetBrains Mono, monospace',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 180, overflowY: 'auto',
          }}>{argsPreview}</pre>
        </details>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
        <button
          onClick={() => { setState('denied'); onDeny() }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}>
          <X className="w-3 h-3" /> Refuser
        </button>
        <button
          onClick={() => { setState('approved'); onApprove() }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
          style={{
            background: 'linear-gradient(135deg, var(--scarlet), var(--scarlet-dark, #b91c1c))',
            color: '#fff', border: 'none', cursor: 'pointer',
            boxShadow: '0 2px 8px color-mix(in srgb, var(--scarlet) 30%, transparent)',
          }}>
          <ShieldCheck className="w-3 h-3" /> Autoriser
        </button>
      </div>
      {permissionId && (
        <div style={{
          fontSize: 9, color: 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace', opacity: 0.5,
        }}>
          id: {permissionId}
        </div>
      )}
    </div>
  )
}
