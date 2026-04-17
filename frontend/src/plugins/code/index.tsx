/**
 * Gungnir Plugin — SpearCode v2.1.1
 *
 * Superior web IDE: command palette, find & replace, minimap, markdown preview,
 * AI code apply, multi-terminal, diff viewer, git integration, status bar.
 * Above Claude Code & OpenCode.
 *
 * Self-contained — no core dependency beyond CSS variables.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

interface TreeEntry { name: string; path: string; is_dir: boolean; size?: number; ext?: string; language?: string; children_count?: number }
interface FileData { path: string; is_text: boolean; content?: string; size: number; language?: string; lines?: number }
interface SearchResult { path: string; name: string; match: 'filename' | 'content'; line?: number; snippet?: string }
interface RunResult { ok: boolean; exit_code: number; stdout: string; stderr: string; elapsed: number; command?: string }
interface OpenTab { path: string; name: string; language: string; content: string; modified: boolean; originalContent: string; cursorLine: number; cursorCol: number }
interface CodingPersona { id: string; name: string; icon: string; description: string; system_prompt: string }
interface GitFile { status: string; path: string }
interface GitStatus { is_repo: boolean; branch?: string; files?: GitFile[]; log?: string[] }
interface ProviderInfo { name: string; default_model: string; enabled: boolean; models: string[] }
interface QuickFile { path: string; name: string; language: string; ext: string }
interface TermEntry { cmd: string; result: RunResult; isAI?: boolean; streaming?: boolean }
interface TermSession { id: string; name: string; history: TermEntry[]; aiHistory: Array<{ role: string; content: string }> }

// ── API ──────────────────────────────────────────────────────────────────────

const API = '/api/plugins/code'
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

// ── Constants ────────────────────────────────────────────────────────────────

function fmtSize(b: number): string { return b < 1024 ? `${b} o` : b < 1048576 ? `${(b / 1024).toFixed(1)} Ko` : `${(b / 1048576).toFixed(1)} Mo` }

const LC: Record<string, string> = {
  python: '#3572A5', javascript: '#f1e05a', typescript: '#3178c6', tsx: '#3178c6',
  jsx: '#f1e05a', json: '#6b7280', html: '#e34c26', css: '#563d7c', scss: '#c6538c',
  markdown: '#083fa1', yaml: '#cb171e', bash: '#89e051', sql: '#e38c00', rust: '#dea584',
  go: '#00ADD8', java: '#b07219', ruby: '#701516', php: '#4F5D95', vue: '#41b883', text: '#6b7280',
}
const PC: Record<string, string> = { architect: '#6366f1', debugger: '#dc2626', reviewer: '#f59e0b', writer: '#3b82f6', tester: '#22c55e', optimizer: '#f97316', hacker: '#8b5cf6' }
const FI: Record<string, string> = {
  '.py': '\u{1F40D}', '.js': '\u{1F4DC}', '.ts': '\u{1F4D8}', '.tsx': '\u269B\uFE0F', '.jsx': '\u269B\uFE0F',
  '.json': '{}', '.html': '\u{1F310}', '.css': '\u{1F3A8}', '.md': '\u{1F4DD}', '.yaml': '\u2699\uFE0F', '.yml': '\u2699\uFE0F',
  '.sh': '\u{1F4BB}', '.rs': '\u{1F980}', '.go': '\u{1F439}', '.java': '\u2615', '.rb': '\u{1F48E}',
  '.png': '\u{1F5BC}\uFE0F', '.jpg': '\u{1F5BC}\uFE0F', '.jpeg': '\u{1F5BC}\uFE0F', '.gif': '\u{1F5BC}\uFE0F', '.svg': '\u{1F5BC}\uFE0F',
}
const GSM: Record<string, { label: string; color: string }> = {
  'M': { label: 'Modifie', color: '#f59e0b' }, 'A': { label: 'Ajoute', color: '#22c55e' },
  'D': { label: 'Supprime', color: '#dc2626' }, '?': { label: 'Non suivi', color: '#6b7280' },
  '??': { label: 'Non suivi', color: '#6b7280' }, 'R': { label: 'Renomme', color: '#3b82f6' },
  'MM': { label: 'Modifie', color: '#f59e0b' }, 'U': { label: 'Conflit', color: '#f97316' },
}
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])
const MONO = '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace'

const S = {
  sl: { fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, letterSpacing: 1, padding: '8px 14px 4px' },
  badge: (c: string, a = false) => ({
    fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
    background: a ? `${c}20` : 'var(--bg-tertiary)', color: a ? c : 'var(--text-muted)',
    border: a ? `1px solid ${c}40` : '1px solid transparent', cursor: 'pointer', transition: 'all 0.15s',
  }),
}

// ── Fuzzy match ──────────────────────────────────────────────────────────────

function fuzzyMatch(query: string, text: string): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase(), t = text.toLowerCase()
  let qi = 0, score = 0, indices: number[] = [], prevIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti)
      score += (ti === prevIdx + 1) ? 10 : (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '.' ? 5 : 1)
      prevIdx = ti; qi++
    }
  }
  return { match: qi === q.length, score, indices }
}

// ── HTML sanitization ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sanitizeSvg(svg: string): string {
  // Robust SVG sanitizer — strips all dangerous elements and attributes
  return svg
    // Remove script tags (including nested/malformed)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    // Remove dangerous elements: foreignObject, iframe, embed, object, use with external refs
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<(iframe|embed|object|applet|form|input|textarea|button)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|embed|object|applet|form|input|textarea|button)\b[^>]*\/?>/gi, '')
    // Remove animate/set that can trigger script (onbegin, onend, onrepeat)
    .replace(/<(animate|set|animateTransform|animateMotion)\b[^>]*\bon\w+\s*=[^>]*>/gi, '')
    // Remove ALL event handlers: on*= with quotes, without quotes, or with HTML entities
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>"']+/gi, '')
    // Remove javascript: / data: / vbscript: URIs (including HTML entity encoding)
    .replace(/(?:java|vb)\s*(?:&#[xX]?[0-9a-fA-F]+;?)*\s*script\s*:/gi, '')
    .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '')
    // Remove xlink:href and href pointing to scripts
    .replace(/(?:xlink:)?href\s*=\s*["'](?:javascript|data|vbscript):[^"']*["']/gi, '')
    .replace(/(?:xlink:)?href\s*=\s*(?:javascript|data|vbscript):[^\s>]*/gi, '')
    // Remove base64 encoded content in attributes that could hide scripts
    .replace(/\bstyle\s*=\s*["'][^"']*expression\s*\([^"']*["']/gi, '')
    .replace(/\bstyle\s*=\s*["'][^"']*url\s*\(\s*["']?(?:javascript|data):[^"']*["']/gi, '')
}

// ── Markdown renderer (lightweight, XSS-safe) ───────────────────────────────

function renderMarkdown(md: string): string {
  // First escape all HTML in the source, then apply markdown formatting
  const escaped = escapeHtml(md)
  return escaped
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:700;margin:12px 0 4px;color:var(--text-primary)">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:800;margin:16px 0 6px;color:var(--text-primary)">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:20px;font-weight:900;margin:20px 0 8px;color:var(--text-primary)">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text-primary)">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg-tertiary);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/^```(\w*)\n([\s\S]*?)```$/gm, '<pre style="background:#0c0f14;padding:12px;border-radius:8px;margin:8px 0;overflow:auto;font-size:12px;line-height:1.5;border:1px solid #1e2633"><code>$2</code></pre>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">\u2022 $1</div>')
    .replace(/^\d+\. (.+)$/gm, '<div style="padding-left:12px;margin:2px 0">$1</div>')
    .replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--scarlet);padding-left:12px;margin:6px 0;color:var(--text-muted)">$1</blockquote>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}

// ── Extract code blocks from AI response ─────────────────────────────────────

function extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
  const blocks: Array<{ language: string; code: string }> = []
  const regex = /```(\w*)\n([\s\S]*?)```/g
  let m
  while ((m = regex.exec(text)) !== null) {
    blocks.push({ language: m[1] || 'text', code: m[2].trimEnd() })
  }
  return blocks
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

// ── Session persistence (survives plugin switches) ──────────────────────────

const SC_STORAGE_KEY = 'spearcode_session'

interface SCSession {
  openPaths: Array<{ path: string; name: string; language: string }>
  activeTab: string | null
  sideView: string
  showTerminal: boolean
}

function loadSession(): SCSession | null {
  try {
    const raw = localStorage.getItem(SC_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveSession(s: SCSession) {
  try { localStorage.setItem(SC_STORAGE_KEY, JSON.stringify(s)) } catch {}
}

export default function SpearCodePlugin() {
  const saved = useRef(loadSession())

  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(saved.current?.activeTab || null)
  const [sideView, setSideView] = useState<'files' | 'search' | 'git' | 'ai' | 'settings' | 'versions' | 'snippets'>((saved.current?.sideView as any) || 'files')
  const [showTerminal, setShowTerminal] = useState(saved.current?.showTerminal || false)
  const [showDiff, setShowDiff] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  const [showFind, setShowFind] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [showCodeActions, setShowCodeActions] = useState(false)
  const [selectedCode, setSelectedCode] = useState('')
  const [codeActionLoading, setCodeActionLoading] = useState(false)
  const [gitBranch, setGitBranch] = useState('')
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const restoredRef = useRef(false)

  const activeFile = useMemo(() => tabs.find(t => t.path === activeTab) || null, [tabs, activeTab])

  // Restore open tabs from previous session
  useEffect(() => {
    if (restoredRef.current || !saved.current?.openPaths?.length) return
    restoredRef.current = true
    const restore = async () => {
      const restored: OpenTab[] = []
      for (const { path, name, language } of saved.current!.openPaths) {
        if (language === '__image__') {
          restored.push({ path, name, language, content: '', modified: false, originalContent: '', cursorLine: 1, cursorCol: 1 })
          continue
        }
        const data = await apiFetch<FileData>(`/file?path=${encodeURIComponent(path)}`)
        if (data?.is_text && data.content != null) {
          restored.push({ path, name, language: data.language || language, content: data.content, modified: false, originalContent: data.content, cursorLine: 1, cursorCol: 1 })
        }
      }
      if (restored.length) {
        setTabs(restored)
        if (saved.current!.activeTab && restored.find(t => t.path === saved.current!.activeTab)) {
          setActiveTab(saved.current!.activeTab)
        } else {
          setActiveTab(restored[0].path)
        }
      }
    }
    restore()
  }, [])

  // Persist session state on changes
  useEffect(() => {
    saveSession({
      openPaths: tabs.map(t => ({ path: t.path, name: t.name, language: t.language })),
      activeTab,
      sideView,
      showTerminal,
    })
  }, [tabs, activeTab, sideView, showTerminal])

  useEffect(() => {
    apiFetch<GitStatus>('/git/status').then(d => { if (d?.is_repo) setGitBranch(d.branch || '') })
  }, [])

  const openFile = useCallback(async (path: string, name?: string) => {
    const n = name || path.split('/').pop() || path
    const ext = '.' + n.split('.').pop()?.toLowerCase()
    if (IMAGE_EXTS.has(ext)) {
      setTabs(prev => {
        if (prev.find(t => t.path === path)) { setActiveTab(path); return prev }
        return [...prev, { path, name: n, language: '__image__', content: '', modified: false, originalContent: '', cursorLine: 1, cursorCol: 1 }]
      })
      setActiveTab(path)
      return
    }
    const existing = tabs.find(t => t.path === path)
    if (existing) { setActiveTab(path); return }
    const data = await apiFetch<FileData>(`/file?path=${encodeURIComponent(path)}`)
    if (!data || !data.is_text || !data.content) return
    setTabs(prev => [...prev, {
      path, name: n, language: data.language || 'text',
      content: data.content!, modified: false, originalContent: data.content!,
      cursorLine: 1, cursorCol: 1,
    }])
    setActiveTab(path)
  }, [tabs])

  const closeTab = useCallback((path: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.path !== path)
      if (activeTab === path) setActiveTab(next.length > 0 ? next[next.length - 1].path : null)
      return next
    })
  }, [activeTab])

  const updateContent = useCallback((path: string, content: string) => {
    setTabs(prev => prev.map(t => t.path === path ? { ...t, content, modified: content !== t.originalContent } : t))
  }, [])

  const updateCursor = useCallback((path: string, line: number, col: number) => {
    setTabs(prev => prev.map(t => t.path === path ? { ...t, cursorLine: line, cursorCol: col } : t))
  }, [])

  const saveFile = useCallback(async (path: string) => {
    const tab = tabs.find(t => t.path === path)
    if (!tab) return
    // Auto-save version before overwriting
    if (tab.originalContent && tab.originalContent !== tab.content) {
      await apiFetch('/version/save', {
        method: 'POST',
        body: JSON.stringify({ path, content: tab.originalContent, label: 'Avant sauvegarde' }),
      })
    }
    const res = await apiFetch<{ ok: boolean }>('/file', { method: 'PUT', body: JSON.stringify({ path, content: tab.content }) })
    if (res?.ok) setTabs(prev => prev.map(t => t.path === path ? { ...t, modified: false, originalContent: tab.content } : t))
  }, [tabs])

  const applyCodeToFile = useCallback(async (code: string) => {
    if (!activeTab) return
    // Auto-save version before applying AI code
    const tab = tabs.find(t => t.path === activeTab)
    if (tab) {
      await apiFetch('/version/save', {
        method: 'POST',
        body: JSON.stringify({ path: tab.path, content: tab.content, label: 'Avant application IA' }),
      })
    }
    updateContent(activeTab, code)
  }, [activeTab, updateContent, tabs])

  // Keyboard shortcuts - using Ctrl+Shift combinations to avoid browser conflicts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key === 's') { e.preventDefault(); if (activeTab) saveFile(activeTab) }
      if (ctrl && e.key === 'k') { e.preventDefault(); setShowPalette(p => !p) }
      if (ctrl && e.key === 'h') { e.preventDefault(); setShowFind(p => !p) }
      if (ctrl && e.key === 'd') { e.preventDefault(); if (activeFile?.modified) setShowDiff(d => !d) }
      if (ctrl && e.key === 'l') { e.preventDefault(); setSideView('ai') }
      if (ctrl && e.shiftKey && e.key === 'A') { e.preventDefault(); setSideView('ai'); window.dispatchEvent(new CustomEvent('spearcode-set-agent')) }
      if (ctrl && e.shiftKey && e.key === 'T') { e.preventDefault(); setShowTerminal(p => !p) }
      if (ctrl && e.shiftKey && e.key === 'P') { e.preventDefault(); if (activeFile?.language === 'markdown') setShowPreview(p => !p) }
      if (ctrl && e.shiftKey && e.key === 'S') { e.preventDefault(); setSideView('snippets') }
      if (e.key === 'Escape') { setShowPalette(false); setShowFind(false); setShowCodeActions(false) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [activeTab, saveFile, activeFile])

  // Code actions handler
  const runCodeAction = useCallback(async (action: string) => {
    if (!selectedCode.trim() || !activeFile) return
    setCodeActionLoading(true)
    setSideView('ai')
    const res = await apiFetch<{ ok: boolean; response?: string; action?: string }>('/ai/code-action', {
      method: 'POST',
      body: JSON.stringify({ action, code: selectedCode, file_path: activeFile.path, language: activeFile.language }),
    })
    setCodeActionLoading(false)
    if (res?.ok && res.response) {
      // Inject the result into the AI panel's current session
      window.dispatchEvent(new CustomEvent('spearcode-action-result', { detail: { action, response: res.response } }))
    }
  }, [selectedCode, activeFile])

  // Track text selection in editor
  useEffect(() => {
    const checkSelection = () => {
      const sel = window.getSelection()?.toString() || ''
      if (sel.length > 5 && sel.length < 10000) {
        setSelectedCode(sel)
        setShowCodeActions(true)
      } else if (sel.length === 0) {
        setShowCodeActions(false)
      }
    }
    document.addEventListener('mouseup', checkSelection)
    return () => document.removeEventListener('mouseup', checkSelection)
  }, [])

  // Export session to markdown
  const exportSession = useCallback(() => {
    const blob = new Blob(
      [`# SpearCode Session Export\n\nDate: ${new Date().toLocaleString('fr-FR')}\n\n---\n\n`],
      { type: 'text/markdown' }
    )
    // We'll build this from the AI panel's custom event
    window.dispatchEvent(new CustomEvent('spearcode-export-session'))
  }, [])

  const canRun = activeFile && ['python', 'javascript', 'typescript', 'bash'].includes(activeFile.language)
  const isMd = activeFile?.language === 'markdown'
  const isImage = activeFile?.language === '__image__'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}>
      {showPalette && <CommandPalette onClose={() => setShowPalette(false)} onOpenFile={openFile} />}

      {/* Header */}
      <div style={{
        padding: '8px 16px', background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--scarlet)" strokeWidth="2.5" style={{ flexShrink: 0 }}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: -0.3, whiteSpace: 'nowrap', flexShrink: 0 }}>SpearCode</span>
        <span style={{
          fontSize: 10, fontFamily: 'monospace', fontWeight: 600,
          padding: '2px 6px', borderRadius: 4, flexShrink: 0,
          background: 'color-mix(in srgb, var(--scarlet) 10%, transparent)',
          color: 'color-mix(in srgb, var(--scarlet) 80%, var(--text-muted))',
          border: '1px solid color-mix(in srgb, var(--scarlet) 20%, transparent)',
        }}>v2.1.1</span>

        <div style={{ flex: 1 }} />

        {/* Quick search */}
        <button onClick={() => setShowPalette(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 6,
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-muted)',
          cursor: 'pointer', fontSize: 11,
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          Recherche rapide
          <kbd style={{ fontSize: 9, padding: '0 4px', background: 'var(--bg-secondary)', borderRadius: 3, border: '1px solid var(--border)' }}>Ctrl+K</kbd>
        </button>

        <div style={{ width: 1, height: 16, background: 'var(--border)' }} />

        {/* Side view toggles */}
        <div style={{ display: 'flex', gap: 1, background: 'var(--bg-tertiary)', borderRadius: 6, padding: 2 }}>
          {([
            ['files', 'Explorateur'],
            ['search', 'Rechercher'],
            ['git', 'Git'],
            ['versions', 'Historique'],
            ['snippets', 'Snippets (Ctrl+Shift+S)'],
            ['ai', 'Assistant IA (Ctrl+L)'],
            ['settings', 'Parametres'],
          ] as const).map(([id, title]) => (
            <HBtn key={id} active={sideView === id} onClick={() => setSideView(id as any)} title={title}>
              {id === 'files' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>}
              {id === 'search' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
              {id === 'git' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>}
              {id === 'versions' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
              {id === 'snippets' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>}
              {id === 'ai' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>}
              {id === 'settings' && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>}
            </HBtn>
          ))}
        </div>

        <div style={{ width: 1, height: 16, background: 'var(--border)' }} />

        <HBtn active={showTerminal} onClick={() => setShowTerminal(!showTerminal)} title="Terminal (Ctrl+Shift+T)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        </HBtn>

        {isMd && <HBtn active={showPreview} onClick={() => setShowPreview(p => !p)} title="Apercu Markdown (Ctrl+Shift+P)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </HBtn>}

        {activeFile?.modified && <>
          <HBtn active={showDiff} onClick={() => setShowDiff(d => !d)} title="Diff (Ctrl+D)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18M3 12h18"/></svg>
          </HBtn>
          <button onClick={() => saveFile(activeTab!)} style={{
            padding: '3px 10px', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600,
            background: 'var(--scarlet)', color: '#fff', cursor: 'pointer',
          }}>Sauvegarder</button>
        </>}
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Side panel */}
        <div style={{
          width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden',
        }}>
          {sideView === 'files' && <FileExplorer onOpenFile={openFile} />}
          {sideView === 'search' && <SearchPanel onOpenFile={openFile} />}
          {sideView === 'git' && <GitPanel onBranchChange={setGitBranch} />}
          {sideView === 'ai' && <AIPanel filePath={activeFile?.path} language={activeFile?.language} onApplyCode={applyCodeToFile} openFiles={tabs.map(t => ({ path: t.path, name: t.name, language: t.language }))} />}
          {sideView === 'settings' && <SettingsPanel />}
          {sideView === 'versions' && <VersionPanel filePath={activeFile?.path} onRestore={(content) => { if (activeTab) updateContent(activeTab, content) }} />}
          {sideView === 'snippets' && <SnippetsPanel language={activeFile?.language} onInsert={(code) => { if (activeTab) { const tab = tabs.find(t => t.path === activeTab); if (tab) updateContent(activeTab, tab.content + '\n' + code) } }} />}
        </div>

        {/* Editor zone */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tabs */}
          {tabs.length > 0 && (
            <div style={{ display: 'flex', overflow: 'auto', flexShrink: 0, background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
              {tabs.map(tab => (
                <TabBtn key={tab.path} tab={tab} active={tab.path === activeTab}
                  onClick={() => setActiveTab(tab.path)} onClose={() => closeTab(tab.path)} />
              ))}
            </div>
          )}

          {/* Breadcrumbs */}
          {activeFile && <Breadcrumbs path={activeFile.path} />}

          {/* Find & Replace */}
          {showFind && activeFile && <FindReplace content={activeFile.content} onChange={c => updateContent(activeFile.path, c)} />}

          {/* Code Actions Bar (appears on selection) */}
          {showCodeActions && selectedCode && activeFile && !isImage && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 3, padding: '3px 10px', flexShrink: 0,
              background: '#1e293b', borderBottom: '1px solid #334155',
            }}>
              <span style={{ fontSize: 8, color: '#8b5cf6', fontWeight: 700, marginRight: 4 }}>ACTIONS IA</span>
              {[
                { id: 'explain', icon: '\u{1F4A1}', label: 'Expliquer' },
                { id: 'refactor', icon: '\u267B\uFE0F', label: 'Refactoriser' },
                { id: 'tests', icon: '\u{1F9EA}', label: 'Tests' },
                { id: 'document', icon: '\u{1F4DD}', label: 'Documenter' },
                { id: 'optimize', icon: '\u26A1', label: 'Optimiser' },
                { id: 'fix', icon: '\u{1F41B}', label: 'Fix bugs' },
              ].map(a => (
                <button key={a.id} onClick={() => runCodeAction(a.id)} disabled={codeActionLoading}
                  style={{
                    border: 'none', cursor: 'pointer', borderRadius: 4, padding: '2px 6px',
                    fontSize: 8, fontWeight: 600, background: '#8b5cf615', color: '#a78bfa',
                    display: 'flex', alignItems: 'center', gap: 2, transition: 'all 0.12s',
                  }}>{a.icon} {a.label}</button>
              ))}
              <button onClick={() => {
                // Save selection as snippet
                const name = prompt('Nom du snippet:')
                if (name) apiFetch('/snippets', { method: 'POST', body: JSON.stringify({ name, code: selectedCode, language: activeFile.language }) })
              }} style={{ border: 'none', cursor: 'pointer', borderRadius: 4, padding: '2px 6px', fontSize: 8, fontWeight: 600, background: '#22c55e15', color: '#22c55e', marginLeft: 'auto' }}>
                {'\u{1F4BE}'} Snippet
              </button>
              <button onClick={() => setShowCodeActions(false)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10, padding: '0 2px' }}>&times;</button>
            </div>
          )}

          {/* Main content */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            {activeFile ? (
              isImage ? <ImagePreview path={activeFile.path} />
              : showDiff && activeFile.modified ? <DiffViewer original={activeFile.originalContent} modified={activeFile.content} language={activeFile.language} fileName={activeFile.name} />
              : showPreview && isMd ? (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <CodeEditor file={activeFile} onChange={c => updateContent(activeFile.path, c)} onSave={() => saveFile(activeFile.path)} onRun={canRun ? () => setShowTerminal(true) : undefined} onCursorChange={(l, c) => updateCursor(activeFile.path, l, c)} />
                  </div>
                  <div style={{ width: 1, background: 'var(--border)' }} />
                  <MarkdownPreview content={activeFile.content} />
                </div>
              ) : (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <CodeEditor file={activeFile} onChange={c => updateContent(activeFile.path, c)} onSave={() => saveFile(activeFile.path)} onRun={canRun ? () => setShowTerminal(true) : undefined} onCursorChange={(l, c) => updateCursor(activeFile.path, l, c)} />
                  </div>
                  <Minimap content={activeFile.content} language={activeFile.language} />
                </div>
              )
            ) : <WelcomeScreen onOpenPalette={() => setShowPalette(true)} />}
          </div>

          {showTerminal && <MultiTerminal runFile={activeFile?.path} onClose={() => setShowTerminal(false)} filePath={activeFile?.path} />}
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar file={activeFile} gitBranch={gitBranch} tabCount={tabs.length} modifiedCount={tabs.filter(t => t.modified).length} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function HBtn({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return <button onClick={onClick} title={title} style={{ padding: '4px 7px', cursor: 'pointer', border: 'none', borderRadius: 4, background: active ? 'var(--scarlet)' : 'transparent', color: active ? '#fff' : 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.12s' }}>{children}</button>
}

function IconBtn({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return <button onClick={onClick} title={title} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 3px', display: 'flex' }}>{children}</button>
}

function TabBtn({ tab, active, onClick, onClose }: { tab: OpenTab; active: boolean; onClick: () => void; onClose: () => void }) {
  const lc = LC[tab.language] || '#6b7280'
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', cursor: 'pointer', flexShrink: 0, fontSize: 11, background: active ? 'var(--bg-primary)' : 'transparent', borderBottom: active ? '2px solid var(--scarlet)' : '2px solid transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)', transition: 'all 0.1s' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: tab.modified ? '#f59e0b' : lc }} />
      <span style={{ fontWeight: active ? 600 : 400, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tab.language === '__image__' ? `\u{1F5BC}\uFE0F ${tab.name}` : tab.name}{tab.modified ? ' *' : ''}
      </span>
      <button onClick={e => { e.stopPropagation(); onClose() }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '0 2px', opacity: 0.4, lineHeight: 1, fontSize: 10 }}>&times;</button>
    </div>
  )
}

function Breadcrumbs({ path }: { path: string }) {
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
// COMMAND PALETTE
// ═══════════════════════════════════════════════════════════════════════════════

function CommandPalette({ onClose, onOpenFile }: { onClose: () => void; onOpenFile: (path: string, name?: string) => void }) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// FIND & REPLACE
// ═══════════════════════════════════════════════════════════════════════════════

function FindReplace({ content, onChange }: { content: string; onChange: (c: string) => void }) {
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

function Minimap({ content, language }: { content: string; language: string }) {
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
// MARKDOWN PREVIEW
// ═══════════════════════════════════════════════════════════════════════════════

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, lineHeight: 1.7 }}>
      <div style={{ maxWidth: 700 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGE PREVIEW
// ═══════════════════════════════════════════════════════════════════════════════

function ImagePreview({ path }: { path: string }) {
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
        <div style={{ marginTop: 12, fontSize: 11, color: '#8b949e' }}>{path} {data.size && `\u2022 ${fmtSize(data.size)}`}</div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS BAR
// ═══════════════════════════════════════════════════════════════════════════════

function StatusBar({ file, gitBranch, tabCount, modifiedCount }: { file: OpenTab | null; gitBranch: string; tabCount: number; modifiedCount: number }) {
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
// FILE EXPLORER
// ═══════════════════════════════════════════════════════════════════════════════

function FileExplorer({ onOpenFile }: { onOpenFile: (path: string, name?: string) => void }) {
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

  const handleCreate = async () => {
    if (!newName.trim()) return
    const full = currentPath ? `${currentPath}/${newName}` : newName
    if (creating === 'folder') await apiFetch('/folder', { method: 'POST', body: JSON.stringify({ path: full }) })
    else await apiFetch('/file', { method: 'PUT', body: JSON.stringify({ path: full, content: '' }) })
    setCreating(null); setNewName(''); loadTree(currentPath)
  }

  const handleDelete = async (path: string, name: string) => {
    if (!confirm(`Supprimer ${name} ?`)) return
    await apiFetch(`/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    loadTree(currentPath)
  }

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
        {currentPath && <IconBtn onClick={navBack}><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg></IconBtn>}
        <span style={{ ...S.sl, padding: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPath || 'Workspace'}</span>
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
        : tree.map(e => <FileRow key={e.path} entry={e} onClick={() => e.is_dir ? navIn(e.path) : onOpenFile(e.path, e.name)} onDelete={() => handleDelete(e.path, e.name)} />)}
      </div>
    </div>
  )
}

function FileRow({ entry, onClick, onDelete }: { entry: TreeEntry; onClick: () => void; onDelete: () => void }) {
  const [h, setH] = useState(false)
  const icon = entry.is_dir ? null : FI[entry.ext || '']
  return (
    <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 12px', cursor: 'pointer', fontSize: 11.5, background: h ? 'var(--bg-tertiary)' : 'transparent', transition: 'background 0.06s' }}>
      {entry.is_dir
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--text-muted)" stroke="none" opacity={0.4}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        : <span style={{ width: 13, textAlign: 'center', fontSize: 10, flexShrink: 0 }}>{icon || '\u{1F4C4}'}</span>}
      <span style={{ flex: 1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
      {!entry.is_dir && entry.language && <span style={{ width: 4, height: 4, borderRadius: '50%', background: LC[entry.language] || '#6b7280', opacity: 0.5 }} />}
      {entry.is_dir && entry.children_count !== undefined && <span style={{ ...S.badge('#6b7280'), fontSize: 7, padding: '0 4px' }}>{entry.children_count}</span>}
      {!entry.is_dir && <span style={{ fontSize: 8, color: 'var(--text-muted)', opacity: 0.4 }}>{fmtSize(entry.size || 0)}</span>}
      {h && <button onClick={e => { e.stopPropagation(); onDelete() }} style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', padding: 0, opacity: 0.5, fontSize: 9 }}>&times;</button>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function SearchPanel({ onOpenFile }: { onOpenFile: (path: string, name?: string) => void }) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// GIT PANEL
// ═══════════════════════════════════════════════════════════════════════════════

function GitPanel({ onBranchChange }: { onBranchChange: (b: string) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [aiGenMsg, setAiGenMsg] = useState(false)
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [showBranches, setShowBranches] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const data = await apiFetch<GitStatus>('/git/status')
    if (data) { setStatus(data); if (data.branch) onBranchChange(data.branch) }
    const br = await apiFetch<{ branches: string[] }>('/git/branches')
    if (br) setBranches(br.branches)
    setLoading(false)
  }, [onBranchChange])

  useEffect(() => { refresh() }, [refresh])

  const initRepo = async () => { await apiFetch<any>('/git/init', { method: 'POST' }); refresh() }
  const commit = async () => {
    if (!commitMsg.trim()) return
    setCommitting(true)
    await apiFetch<any>('/git/commit', { method: 'POST', body: JSON.stringify({ message: commitMsg }) })
    setCommitMsg(''); setCommitting(false); refresh()
  }
  const toggleDiff = async (path: string) => {
    if (diffFile === path) { setDiffFile(null); setDiffContent(null); return }
    const data = await apiFetch<{ diff: string; staged: string }>(`/git/diff?path=${encodeURIComponent(path)}`)
    setDiffFile(path); setDiffContent(data ? (data.diff || data.staged || 'Pas de diff') : 'Erreur')
  }
  const switchBranch = async (br: string) => {
    await apiFetch<any>('/git/checkout', { method: 'POST', body: JSON.stringify({ branch: br }) })
    setShowBranches(false); refresh()
  }

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>Chargement...</div>
  if (!status?.is_repo) return (
    <div style={{ padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>Pas de depot Git</div>
      <button onClick={initRepo} style={{ padding: '6px 16px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600, background: 'var(--scarlet)', color: '#fff', cursor: 'pointer' }}>Initialiser Git</button>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        <button onClick={() => setShowBranches(!showBranches)} style={{ border: 'none', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 700, fontSize: 11 }}>
          {status.branch} {branches.length > 1 ? '\u25BE' : ''}
        </button>
        <div style={{ flex: 1 }} />
        <IconBtn onClick={refresh} title="Rafraichir"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></IconBtn>
      </div>
      {showBranches && branches.length > 1 && (
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
          {branches.map(br => (
            <div key={br} onClick={() => switchBranch(br)} style={{ padding: '4px 12px', fontSize: 11, cursor: 'pointer', color: br === status.branch ? 'var(--scarlet)' : 'var(--text-primary)', fontWeight: br === status.branch ? 700 : 400 }}>
              {br === status.branch ? '\u2022 ' : '  '}{br}
            </div>
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={S.sl}>Changements ({status.files?.length || 0})</div>
        {!status.files?.length ? <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-muted)' }}>Aucun changement</div>
        : status.files.map((f, i) => {
          const st = GSM[f.status] || { label: f.status, color: '#6b7280' }
          return (
            <div key={i}>
              <div onClick={() => toggleDiff(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 11 }}>
                <span style={{ ...S.badge(st.color, true), fontSize: 7, padding: '0 5px' }}>{st.label}</span>
                <span style={{ flex: 1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
              </div>
              {diffFile === f.path && diffContent && (
                <pre style={{ margin: '0 12px 6px', padding: 6, borderRadius: 4, fontSize: 9, background: '#0c0f14', color: '#c9d1d9', overflow: 'auto', maxHeight: 180, fontFamily: MONO, lineHeight: 1.4, border: '1px solid #1e2633' }}>
                  {diffContent.split('\n').map((line, li) => <div key={li} style={{ color: line.startsWith('+') ? '#22c55e' : line.startsWith('-') ? '#f85149' : line.startsWith('@@') ? '#3b82f6' : '#c9d1d9' }}>{line}</div>)}
                </pre>
              )}
            </div>
          )
        })}
        {status.log && status.log.length > 0 && <>
          <div style={{ ...S.sl, marginTop: 8 }}>Historique</div>
          {status.log.map((l, i) => <div key={i} style={{ padding: '2px 12px', fontSize: 9, color: '#8b949e', fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span style={{ color: '#f59e0b' }}>{l.substring(0, 7)}</span> {l.substring(8)}</div>)}
        </>}
      </div>
      {status.files && status.files.length > 0 && (
        <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input value={commitMsg} onChange={e => setCommitMsg(e.target.value)} onKeyDown={e => e.key === 'Enter' && commit()} placeholder="Message de commit..." style={{ flex: 1, padding: '5px 8px', fontSize: 11, borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
            <button onClick={async () => {
              setAiGenMsg(true)
              const diffData = await apiFetch<{ diff: string; staged: string }>('/git/diff')
              const fullDiff = (diffData?.diff || '') + '\n' + (diffData?.staged || '')
              if (!fullDiff.trim()) { setAiGenMsg(false); return }
              const res = await apiFetch<{ ok: boolean; message?: string }>('/git/ai-commit-message', {
                method: 'POST', body: JSON.stringify({ diff: fullDiff }),
              })
              if (res?.ok && res.message) setCommitMsg(res.message)
              setAiGenMsg(false)
            }} disabled={aiGenMsg} title="Generer message IA depuis le diff"
              style={{ padding: '4px 8px', borderRadius: 5, border: 'none', fontSize: 9, fontWeight: 700, cursor: 'pointer', background: '#8b5cf620', color: '#8b5cf6', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}>
              {aiGenMsg ? <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#8b5cf6', animation: 'pulse 1s ease-in-out infinite' }} /> : '\u2728'} IA
            </button>
          </div>
          <button onClick={commit} disabled={committing || !commitMsg.trim()} style={{ width: '100%', padding: '5px 0', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, cursor: commitMsg.trim() ? 'pointer' : 'not-allowed', background: commitMsg.trim() ? 'var(--scarlet)' : 'var(--bg-tertiary)', color: commitMsg.trim() ? '#fff' : 'var(--text-muted)' }}>
            {committing ? 'Commit...' : 'Commit'}
          </button>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS PANEL (with model selector)
// ═══════════════════════════════════════════════════════════════════════════════

const PROVIDER_PRESETS: { id: string; label: string; hint: string; baseUrlPlaceholder?: string }[] = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'Claude + GPT + 200 modeles via cle unique' },
  { id: 'anthropic', label: 'Anthropic (Claude API)', hint: 'console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', hint: 'platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Gemini', hint: 'aistudio.google.com/apikey' },
  { id: 'groq', label: 'Groq', hint: 'console.groq.com/keys' },
  { id: 'minimax', label: 'MiniMax', hint: '' },
  { id: 'ollama', label: 'Ollama (local)', hint: 'base URL http://localhost:11434', baseUrlPlaceholder: 'http://localhost:11434' },
  { id: 'custom', label: 'Personnalise…', hint: 'Entre un nom + base URL compatible OpenAI', baseUrlPlaceholder: 'https://…/v1' },
]

function SettingsPanel() {
  const [config, setConfig] = useState<any>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [wsInput, setWsInput] = useState('')
  const [fontInput, setFontInput] = useState(14)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Add-provider form state
  const [showAdd, setShowAdd] = useState(false)
  const [addPreset, setAddPreset] = useState(PROVIDER_PRESETS[0].id)
  const [addCustomName, setAddCustomName] = useState('')
  const [addApiKey, setAddApiKey] = useState('')
  const [addBaseUrl, setAddBaseUrl] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')

  const reloadProviders = useCallback(() => {
    apiFetch<{ providers: ProviderInfo[] }>('/providers').then(p => { if (p) setProviders(p.providers) })
  }, [])

  useEffect(() => {
    apiFetch<any>('/config').then(c => { if (c) { setConfig(c); setWsInput(c.workspace || ''); setFontInput(c.font_size || 14) } })
    reloadProviders()
  }, [reloadProviders])

  const save = async () => {
    setSaving(true)
    await apiFetch('/config', { method: 'PUT', body: JSON.stringify({ workspace: wsInput || undefined, font_size: fontInput }) })
    setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const submitAddProvider = async () => {
    setAddError('')
    const preset = PROVIDER_PRESETS.find(p => p.id === addPreset)!
    const name = preset.id === 'custom' ? addCustomName.trim().toLowerCase() : preset.id
    if (!name) { setAddError('Nom du provider requis'); return }
    if (!addApiKey.trim() && preset.id !== 'ollama') { setAddError('Cle API requise'); return }
    setAddBusy(true)
    try {
      const body: any = { api_key: addApiKey.trim() || 'local', enabled: true }
      if (addBaseUrl.trim()) body.base_url = addBaseUrl.trim()
      const res = await fetch(`/api/config/user/providers/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        setAddError(`Erreur ${res.status}: ${msg.slice(0, 200)}`)
        return
      }
      setAddApiKey(''); setAddBaseUrl(''); setAddCustomName(''); setShowAdd(false)
      reloadProviders()
    } finally {
      setAddBusy(false)
    }
  }

  const removeProvider = async (name: string) => {
    if (!confirm(`Supprimer la cle ${name} ?`)) return
    await fetch(`/api/config/user/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
    reloadProviders()
  }

  const currentPreset = PROVIDER_PRESETS.find(p => p.id === addPreset)!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div style={{ ...S.sl, paddingTop: 12 }}>Parametres SpearCode</div>
      <div style={{ padding: '6px 12px' }}>
        <label style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }}>Workspace</label>
        <input value={wsInput} onChange={e => setWsInput(e.target.value)} placeholder="data/workspace" style={{ width: '100%', padding: '5px 10px', fontSize: 11, borderRadius: 5, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>
      <div style={{ padding: '6px 12px' }}>
        <label style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 3, display: 'block' }}>Police ({fontInput}px)</label>
        <input type="range" min={8} max={24} value={fontInput} onChange={e => setFontInput(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--scarlet)' }} />
      </div>
      <div style={{ padding: '4px 12px 10px' }}>
        <button onClick={save} disabled={saving} style={{ width: '100%', padding: '5px 0', borderRadius: 5, border: 'none', fontSize: 10, fontWeight: 600, cursor: 'pointer', background: saved ? '#22c55e' : 'var(--scarlet)', color: '#fff', transition: 'background 0.3s' }}>
          {saving ? 'Sauvegarde...' : saved ? 'OK !' : 'Sauvegarder'}
        </button>
      </div>

      <div style={{ borderTop: '1px solid var(--border)' }}>
        <div style={{ ...S.sl, paddingTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1 }}>Providers IA</span>
          <button onClick={() => setShowAdd(s => !s)}
            style={{ border: 'none', cursor: 'pointer', background: showAdd ? 'var(--bg-tertiary)' : 'var(--scarlet)', color: showAdd ? 'var(--text-primary)' : '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 9, fontWeight: 700, letterSpacing: 0.3 }}>
            {showAdd ? 'Annuler' : '+ Ajouter'}
          </button>
        </div>

        {showAdd && (
          <div style={{ padding: '6px 12px 10px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label style={{ fontSize: 9, color: 'var(--text-muted)' }}>Provider</label>
            <select value={addPreset} onChange={e => setAddPreset(e.target.value)}
              style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }}>
              {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {currentPreset.hint && <span style={{ fontSize: 9, color: 'var(--text-muted)', opacity: 0.8 }}>{currentPreset.hint}</span>}

            {addPreset === 'custom' && (
              <input value={addCustomName} onChange={e => setAddCustomName(e.target.value)} placeholder="nom (ex. together)" autoCapitalize="none" autoCorrect="off"
                style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none' }} />
            )}

            <input type="password" value={addApiKey} onChange={e => setAddApiKey(e.target.value)}
              placeholder={addPreset === 'ollama' ? 'Laisse vide (local)' : 'sk-...'}
              autoComplete="new-password"
              style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />

            {(currentPreset.baseUrlPlaceholder || addPreset === 'custom') && (
              <input value={addBaseUrl} onChange={e => setAddBaseUrl(e.target.value)} placeholder={currentPreset.baseUrlPlaceholder || 'Base URL (optionnel)'}
                style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', outline: 'none', fontFamily: MONO }} />
            )}

            {addError && <span style={{ fontSize: 10, color: '#f87171' }}>{addError}</span>}

            <button onClick={submitAddProvider} disabled={addBusy}
              style={{ marginTop: 2, padding: '5px 0', borderRadius: 4, border: 'none', fontSize: 10, fontWeight: 700, cursor: addBusy ? 'wait' : 'pointer', background: 'var(--scarlet)', color: '#fff' }}>
              {addBusy ? 'Enregistrement...' : 'Enregistrer la cle'}
            </button>
          </div>
        )}

        {providers.length === 0
          ? <div style={{ padding: '6px 12px', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Aucun provider configure. Clique sur <b>+ Ajouter</b> pour brancher OpenRouter, Anthropic, OpenAI, etc.
            </div>
          : providers.map(p => (
            <div key={p.name} style={{ padding: '5px 12px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--border)' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e' }} />
              <span style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 600, flex: 1 }}>{p.name}</span>
              <span style={{ ...S.badge('#3b82f6', true), fontSize: 8 }}>{p.default_model}</span>
              <button onClick={() => removeProvider(p.name)} title="Supprimer la cle"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#dc2626', opacity: 0.6, padding: '0 3px', fontSize: 11 }}>&times;</button>
            </div>
          ))
        }
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '0 12px 14px' }}>
        <div style={{ ...S.sl, padding: '10px 0 6px' }}>Raccourcis</div>
        {[['Ctrl+K', 'Command palette'], ['Ctrl+S', 'Sauvegarder'], ['Ctrl+H', 'Chercher/Remplacer'], ['Ctrl+D', 'Diff'], ['Ctrl+Shift+T', 'Terminal'], ['Ctrl+Shift+P', 'Apercu Markdown']].map(([k, d]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <kbd style={{ padding: '0 5px', background: 'var(--bg-tertiary)', borderRadius: 3, fontSize: 9, border: '1px solid var(--border)', fontFamily: MONO, minWidth: 55, textAlign: 'center', color: 'var(--text-primary)' }}>{k}</kbd>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI PANEL — Model switching, context reduction, sessions, token tracking
// Redesigned: intuitive layout, ScarletWolf charte graphique
// ═══════════════════════════════════════════════════════════════════════════════

const SPEAR_FAV_KEY = 'spearcode_favorite_models'  // Independent from main chat favorites
const SPEAR_MODEL_KEY = 'spearcode_model'
const SPEAR_SESSIONS_KEY = 'spearcode_ai_sessions'
const CTX_MODES = [
  { id: 'smart', label: 'Smart', icon: '\u26A1', desc: 'Extrait les parties pertinentes du fichier', color: '#22c55e' },
  { id: 'selection', label: 'Selection', icon: '\u{1F3AF}', desc: 'Code selectionne uniquement', color: '#3b82f6' },
  { id: 'full', label: 'Complet', icon: '\u{1F4C4}', desc: 'Fichier entier', color: '#f59e0b' },
  { id: 'none', label: 'Sans', icon: '\u{1F6AB}', desc: 'Pas de contexte fichier', color: '#6b7280' },
] as const

interface AISession { id: string; name: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; tokens: number }
interface AgentStep { type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error'; step: number; tool?: string; args?: any; result?: string; content?: string; reasoning?: string; error?: string }

function AIPanel({ filePath, language, onApplyCode, openFiles = [] }: { filePath?: string; language?: string; onApplyCode: (code: string) => void; openFiles?: Array<{ path: string; name: string; language: string }> }) {
  const [personas, setPersonas] = useState<CodingPersona[]>([])
  const [activePersona, setActivePersona] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [tokenStats, setTokenStats] = useState({ context: 0, total: 0, msgs: 0 })
  const [streamingText, setStreamingText] = useState('')
  const [mode, setMode] = useState<'chat' | 'agent'>('chat')
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  const [agentRunning, setAgentRunning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Sessions
  const [sessions, setSessions] = useState<AISession[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SPEAR_SESSIONS_KEY) || '[]')
      return saved.length > 0 ? saved : [{ id: '1', name: 'Session 1', messages: [], tokens: 0 }]
    } catch { return [{ id: '1', name: 'Session 1', messages: [], tokens: 0 }] }
  })
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id || '1')
  const nextSessionId = useRef(sessions.length + 1)
  const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0]
  const messages = activeSession?.messages || []

  const updateSession = useCallback((fn: (s: AISession) => AISession) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === activeSessionId ? fn(s) : s)
      localStorage.setItem(SPEAR_SESSIONS_KEY, JSON.stringify(next))
      return next
    })
  }, [activeSessionId])

  // Model selection
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(SPEAR_FAV_KEY) || '[]') } catch { return [] }
  })

  // Refresh models for a specific provider (or all)
  const refreshModels = async (providerName?: string) => {
    setLoadingModels(true)
    try {
      if (providerName) {
        const d = await apiFetch<{ provider: string; models: string[] }>(`/providers/${providerName}/models`)
        if (d?.models) {
          setProviders(prev => prev.map(p => p.name === providerName ? { ...p, models: d.models } : p))
        }
      } else {
        const d = await apiFetch<{ providers: ProviderInfo[] }>('/providers')
        if (d?.providers) setProviders(d.providers)
      }
    } catch { /* ignore */ }
    setLoadingModels(false)
  }

  // Context reduction
  const [contextMode, setContextMode] = useState<'smart' | 'selection' | 'full' | 'none'>('smart')
  const [multiFileCtx, setMultiFileCtx] = useState(false)
  const [hasProjectRules, setHasProjectRules] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Check for .spearcode rules
  useEffect(() => {
    apiFetch<{ ok: boolean; exists: boolean }>('/project-rules').then(d => { if (d) setHasProjectRules(d.exists) })
  }, [])

  // Listen for code action results
  useEffect(() => {
    const handleActionResult = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.response) {
        updateSession(s => ({
          ...s,
          messages: [...s.messages,
            { role: 'user', content: `[Action IA: ${detail.action}]` },
            { role: 'assistant', content: detail.response },
          ],
        }))
      }
    }
    const handleSetAgent = () => setMode('agent')
    const handleExport = () => {
      const md = messages.map(m => `### ${m.role === 'user' ? 'Vous' : 'SpearCode'}\n\n${m.content}\n`).join('\n---\n\n')
      const blob = new Blob([`# SpearCode Session\n\nDate: ${new Date().toLocaleString('fr-FR')}\n\n---\n\n${md}`], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `spearcode_session_${Date.now()}.md`; a.click()
      URL.revokeObjectURL(url)
    }
    window.addEventListener('spearcode-action-result', handleActionResult)
    window.addEventListener('spearcode-set-agent', handleSetAgent)
    window.addEventListener('spearcode-export-session', handleExport)
    return () => {
      window.removeEventListener('spearcode-action-result', handleActionResult)
      window.removeEventListener('spearcode-set-agent', handleSetAgent)
      window.removeEventListener('spearcode-export-session', handleExport)
    }
  }, [messages, updateSession])

  // Load saved model preference
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SPEAR_MODEL_KEY) || '{}')
      if (saved.provider) setSelectedProvider(saved.provider)
      if (saved.model) setSelectedModel(saved.model)
    } catch { /* ignore */ }
  }, [])

  // Load providers & personas
  useEffect(() => {
    apiFetch<{ personas: CodingPersona[] }>('/personas').then(d => d && setPersonas(d.personas))
    apiFetch<{ providers: ProviderInfo[] }>('/providers').then(d => {
      if (d?.providers) {
        setProviders(d.providers)
        if (!selectedProvider && d.providers.length > 0) {
          setSelectedProvider(d.providers[0].name)
          setSelectedModel(d.providers[0].default_model)
        }
      }
    })
  }, [])

  const selectModel = (provName: string, model: string) => {
    setSelectedProvider(provName)
    setSelectedModel(model)
    setShowModelMenu(false)
    setModelSearch('')
    localStorage.setItem(SPEAR_MODEL_KEY, JSON.stringify({ provider: provName, model }))
  }

  const toggleFavorite = (provName: string, model: string) => {
    const key = `${provName}::${model}`
    setFavorites(prev => {
      const next = prev.includes(key) ? prev.filter(f => f !== key) : prev.length >= 8 ? prev : [...prev, key]
      localStorage.setItem(SPEAR_FAV_KEY, JSON.stringify(next))
      return next
    })
  }

  // Session management
  const newSession = () => {
    const id = String(nextSessionId.current++)
    const s: AISession = { id, name: `Session ${id}`, messages: [], tokens: 0 }
    setSessions(prev => {
      const next = [...prev, s]
      localStorage.setItem(SPEAR_SESSIONS_KEY, JSON.stringify(next))
      return next
    })
    setActiveSessionId(id)
    setTokenStats({ context: 0, total: 0, msgs: 0 })
  }

  const compactSession = () => {
    // Compact: summarize context, keep last 2 messages, start fresh-ish
    if (messages.length < 4) return
    const summary = `[Session compactee — ${messages.length} messages, ~${activeSession.tokens} tokens]\nDernier sujet: ${messages[messages.length - 2]?.content.substring(0, 100)}...`
    updateSession(s => ({
      ...s,
      messages: [
        { role: 'assistant', content: summary },
        ...s.messages.slice(-2),
      ],
      tokens: Math.round(s.tokens * 0.2),
    }))
    setTokenStats(prev => ({ ...prev, total: Math.round(prev.total * 0.2) }))
  }

  const closeSession = (id: string) => {
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id)
      if (next.length === 0) next.push({ id: '1', name: 'Session 1', messages: [], tokens: 0 })
      if (activeSessionId === id) setActiveSessionId(next[next.length - 1].id)
      localStorage.setItem(SPEAR_SESSIONS_KEY, JSON.stringify(next))
      return next
    })
  }

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
      setLoading(false)
      setAgentRunning(false)
      setStreamingText('')
      setAgentSteps([])
      updateSession(s => ({ ...s, messages: [...s.messages, { role: 'assistant', content: '[Generation arretee]' }] }))
    }
  }, [updateSession])

  // ── Streaming send (SSE) ────────────────────────────────────────────────
  const send = async () => {
    if (!input.trim() || loading) return
    const msg = input.trim()
    updateSession(s => ({ ...s, messages: [...s.messages, { role: 'user', content: msg }] }))
    setInput(''); setLoading(true); setStreamingText('')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/ai/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          file_path: filePath || null,
          persona: activePersona,
          provider_name: selectedProvider || undefined,
          model_name: selectedModel || undefined,
          context_mode: contextMode,
          history: messages.slice(-8).map(m => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No stream reader')
      const decoder = new TextDecoder()
      let buffer = ''
      let fullText = ''
      let totalTokens = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'token') {
              fullText += event.content
              setStreamingText(fullText)
              requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
            } else if (event.type === 'done') {
              fullText = event.full_text || fullText
              totalTokens = event.token_estimate || 0
            } else if (event.type === 'error') {
              fullText = `Erreur: ${event.error}`
            }
          } catch { /* skip malformed */ }
        }
      }

      setStreamingText('')
      updateSession(s => ({
        ...s,
        messages: [...s.messages, { role: 'assistant', content: fullText }],
        tokens: s.tokens + (typeof totalTokens === 'number' ? totalTokens : 0),
      }))

      if (totalTokens && typeof totalTokens === 'object') {
        setTokenStats(prev => ({
          context: (totalTokens as any).context || prev.context,
          total: prev.total + ((totalTokens as any).total || 0),
          msgs: prev.msgs + 2,
        }))
      }
    } catch (err: any) {
      setStreamingText('')
      if (err.name !== 'AbortError') {
        updateSession(s => ({ ...s, messages: [...s.messages, { role: 'assistant', content: `Erreur: ${err.message}` }] }))
      }
    } finally {
      abortRef.current = null
      setLoading(false)
      setStreamingText('')
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
    }
  }

  // ── Agent mode ────────────────────────────────────────────────────────────
  const runAgent = async () => {
    if (!input.trim() || agentRunning) return
    const task = input.trim()
    setInput(''); setAgentRunning(true); setAgentSteps([])
    updateSession(s => ({ ...s, messages: [...s.messages, { role: 'user', content: `🤖 Agent: ${task}` }] }))

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/ai/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task,
          file_path: filePath || null,
          provider_name: selectedProvider || undefined,
          model_name: selectedModel || undefined,
          max_steps: 10,
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No stream reader')
      const decoder = new TextDecoder()
      let buffer = ''
      let finalResponse = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'thinking') {
              setAgentSteps(prev => [...prev, { type: 'thinking', step: event.step }])
            } else if (event.type === 'tool_call') {
              setAgentSteps(prev => [...prev, { type: 'tool_call', step: event.step, tool: event.tool, args: event.args, reasoning: event.reasoning }])
            } else if (event.type === 'tool_result') {
              setAgentSteps(prev => [...prev, { type: 'tool_result', step: event.step, tool: event.tool, result: event.result }])
            } else if (event.type === 'response') {
              finalResponse = event.content || ''
              setAgentSteps(prev => [...prev, { type: 'response', step: event.step, content: event.content }])
            } else if (event.type === 'error') {
              setAgentSteps(prev => [...prev, { type: 'error', step: event.step || 0, error: event.error }])
            }
            requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
          } catch { /* skip */ }
        }
      }

      if (finalResponse) {
        updateSession(s => ({ ...s, messages: [...s.messages, { role: 'assistant', content: finalResponse }] }))
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setAgentSteps(prev => [...prev, { type: 'error', step: 0, error: err.message }])
      }
    } finally {
      abortRef.current = null
      setAgentRunning(false)
      setAgentSteps([])
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
    }
  }

  const modelShort = selectedModel ? selectedModel.split('/').pop()?.substring(0, 22) || selectedModel : 'defaut'
  const curCtx = CTX_MODES.find(m => m.id === contextMode)!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Header: Model + Context ─────────────────────────────── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
        {/* Model selector row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, position: 'relative' }}>
          <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Modele</span>
          <button onClick={() => setShowModelMenu(!showModelMenu)} title="Changer de modele IA"
            style={{
              flex: 1, display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', fontSize: 10, fontWeight: 600,
              transition: 'border-color 0.15s',
            }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--scarlet)', flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{modelShort}</span>
            <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>{selectedProvider || 'auto'}</span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>

          {/* Model dropdown */}
          {showModelMenu && (
            <div onClick={() => setShowModelMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
          )}
          {showModelMenu && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4,
              maxHeight: 360, background: 'var(--bg-secondary)', borderRadius: 10,
              border: '1px solid var(--border)', overflow: 'hidden', boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            }}>
              <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="Rechercher un modele..."
                  autoFocus style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 11 }} />
                <button onClick={() => refreshModels()} title="Rafraichir les modeles depuis les providers"
                  disabled={loadingModels}
                  style={{ background: 'none', border: 'none', cursor: loadingModels ? 'wait' : 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={loadingModels ? 'var(--scarlet)' : 'var(--text-muted)'} strokeWidth="2"
                    style={{ animation: loadingModels ? 'spin 1s linear infinite' : 'none' }}>
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                  </svg>
                </button>
              </div>

              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                {/* SpearCode favorites */}
                {!modelSearch && favorites.length > 0 && <>
                  <div style={{ padding: '6px 10px 3px', fontSize: 8, fontWeight: 700, color: 'var(--scarlet)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{'\u2605'} Favoris SpearCode</div>
                  {favorites.map(fav => {
                    const [prov, ...mParts] = fav.split('::')
                    const model = mParts.join('::')
                    const shortName = model.split('/').pop() || model
                    return (
                      <ModelRow key={fav} provider={prov} model={model} shortName={shortName}
                        isActive={selectedProvider === prov && selectedModel === model}
                        isFav={true} onSelect={() => selectModel(prov, model)}
                        onToggleFav={() => toggleFavorite(prov, model)} />
                    )
                  })}
                  <div style={{ borderBottom: '1px solid var(--border)', margin: '4px 0' }} />
                </>}

                {/* Provider groups */}
                {providers.map(prov => {
                  const models = prov.models.length > 0 ? prov.models : [prov.default_model]
                  const filtered = modelSearch
                    ? models.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase()))
                    : models
                  if (filtered.length === 0) return null
                  const displayLimit = modelSearch ? 50 : 20
                  return (
                    <div key={prov.name}>
                      <div style={{ padding: '6px 10px 3px', fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>{prov.name}</span>
                        <span style={{ fontWeight: 400, opacity: 0.6 }}>{filtered.length}{filtered.length < models.length ? `/${models.length}` : ''} modeles</span>
                      </div>
                      {filtered.slice(0, displayLimit).map(m => {
                        const shortName = m.split('/').pop() || m
                        const favKey = `${prov.name}::${m}`
                        return (
                          <ModelRow key={m} provider={prov.name} model={m} shortName={shortName}
                            isActive={selectedProvider === prov.name && selectedModel === m}
                            isFav={favorites.includes(favKey)} onSelect={() => selectModel(prov.name, m)}
                            onToggleFav={() => toggleFavorite(prov.name, m)} />
                        )
                      })}
                      {filtered.length > displayLimit && (
                        <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          ... et {filtered.length - displayLimit} autres (utilisez la recherche)
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Mode toggle + Context mode row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Chat / Agent toggle */}
          <div style={{ display: 'flex', borderRadius: 5, overflow: 'hidden', border: '1px solid var(--border)', marginRight: 4 }}>
            <button onClick={() => setMode('chat')} style={{
              border: 'none', cursor: 'pointer', padding: '2px 7px', fontSize: 8, fontWeight: 700,
              background: mode === 'chat' ? 'var(--scarlet)' : 'transparent',
              color: mode === 'chat' ? '#fff' : 'var(--text-muted)', transition: 'all 0.12s',
            }}>Chat</button>
            <button onClick={() => setMode('agent')} style={{
              border: 'none', cursor: 'pointer', padding: '2px 7px', fontSize: 8, fontWeight: 700,
              background: mode === 'agent' ? '#8b5cf6' : 'transparent',
              color: mode === 'agent' ? '#fff' : 'var(--text-muted)', transition: 'all 0.12s',
            }}>{'\u{1F916}'} Agent</button>
          </div>
          <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 2 }}>Ctx</span>
          {CTX_MODES.map(m => (
            <button key={m.id} onClick={() => setContextMode(m.id as any)} title={`${m.label}: ${m.desc}`}
              style={{
                border: 'none', cursor: 'pointer', borderRadius: 4, padding: '2px 6px',
                fontSize: 8, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2,
                background: contextMode === m.id ? `${m.color}20` : 'transparent',
                color: contextMode === m.id ? m.color : 'var(--text-muted)',
                outline: contextMode === m.id ? `1px solid ${m.color}40` : 'none',
                transition: 'all 0.12s',
              }}>
              {m.icon}
              {contextMode === m.id && <span>{m.label}</span>}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {tokenStats.total > 0 && (
            <span title={`Contexte: ~${tokenStats.context} | Session: ~${tokenStats.total}`}
              style={{ fontSize: 8, color: tokenStats.total > 5000 ? '#f59e0b' : '#22c55e', fontWeight: 600, cursor: 'help' }}>
              ~{tokenStats.total > 1000 ? `${(tokenStats.total / 1000).toFixed(1)}k` : tokenStats.total} tok
            </span>
          )}
        </div>
      </div>

      {/* ── Personas ─────────────────────────────────────────────── */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 2 }}>IA</span>
        {personas.map(p => (
          <button key={p.id} onClick={() => setActivePersona(activePersona === p.id ? null : p.id)} title={p.description}
            style={{
              border: 'none', cursor: 'pointer', borderRadius: 4, padding: '2px 5px',
              fontSize: 8, fontWeight: 600,
              background: activePersona === p.id ? `${PC[p.id]}20` : 'transparent',
              color: activePersona === p.id ? PC[p.id] : 'var(--text-muted)',
              outline: activePersona === p.id ? `1px solid ${PC[p.id]}40` : 'none',
              transition: 'all 0.12s',
            }}>{p.icon} {p.name}</button>
        ))}
      </div>

      {/* ── Session tabs ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0, overflow: 'auto' }}>
        {sessions.map(s => (
          <div key={s.id} onClick={() => { setActiveSessionId(s.id); setTokenStats(prev => ({ ...prev, total: s.tokens })) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', cursor: 'pointer', fontSize: 9,
              color: s.id === activeSessionId ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: s.id === activeSessionId ? '2px solid var(--scarlet)' : '2px solid transparent',
              fontWeight: s.id === activeSessionId ? 600 : 400,
            }}>
            <span>{s.name}</span>
            <span style={{ fontSize: 7, opacity: 0.4 }}>{s.messages.length > 0 ? `(${s.messages.length})` : ''}</span>
            {sessions.length > 1 && (
              <button onClick={e => { e.stopPropagation(); closeSession(s.id) }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 8, padding: 0, opacity: 0.3 }}>&times;</button>
            )}
          </div>
        ))}
        <button onClick={newSession} title="Nouvelle session" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: '3px 6px' }}>+</button>
        <div style={{ flex: 1 }} />
        {messages.length >= 4 && (
          <button onClick={compactSession} title="Compacter la session (reduire les tokens)" style={{
            border: 'none', cursor: 'pointer', padding: '2px 6px', marginRight: 4,
            borderRadius: 3, fontSize: 8, fontWeight: 600,
            background: '#6366f120', color: '#6366f1',
          }}>{'\u{1F5DC}\uFE0F'} Compacter</button>
        )}
      </div>

      {/* ── File indicator + controls ─────────────────────────────── */}
      <div style={{ padding: '2px 10px', fontSize: 9, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {filePath
          ? <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: curCtx.color }} />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 9 }}>{filePath.split('/').pop()}</span>
              <span style={{ fontSize: 7, color: curCtx.color }}>{curCtx.label}</span>
            </span>
          : <span style={{ opacity: 0.4 }}>Aucun fichier ouvert</span>
        }
        {openFiles.length > 1 && (
          <button onClick={() => setMultiFileCtx(!multiFileCtx)} title={multiFileCtx ? 'Multi-fichiers ON' : 'Multi-fichiers OFF'}
            style={{ border: 'none', cursor: 'pointer', borderRadius: 3, padding: '0 4px', fontSize: 7, fontWeight: 700, background: multiFileCtx ? '#3b82f620' : 'transparent', color: multiFileCtx ? '#3b82f6' : 'var(--text-muted)' }}>
            {'\u{1F4C1}'}{openFiles.length}
          </button>
        )}
        {hasProjectRules && <span title="Regles .spearcode actives" style={{ fontSize: 7, color: '#22c55e', fontWeight: 700 }}>{'\u2699\uFE0F'}.spearcode</span>}
        <div style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button onClick={() => window.dispatchEvent(new CustomEvent('spearcode-export-session'))} title="Exporter la session en Markdown" style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 8, opacity: 0.4 }}>{'\u{1F4E4}'}</button>
        )}
        {messages.length > 0 && <button onClick={() => { updateSession(s => ({ ...s, messages: [], tokens: 0 })); setTokenStats({ context: 0, total: 0, msgs: 0 }) }} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 8, opacity: 0.4 }}>Effacer</button>}
      </div>

      {/* ── Messages ─────────────────────────────────────────────── */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {messages.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', lineHeight: 2 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={mode === 'agent' ? '#8b5cf6' : 'var(--scarlet)'} strokeWidth="1.5" style={{ marginBottom: 8, opacity: 0.5 }}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
              {mode === 'agent' ? '\u{1F916} SpearCode Agent' : 'SpearCode IA'}
            </div>
            <div style={{ fontSize: 10, opacity: 0.6 }}>
              {mode === 'agent'
                ? <>Decrivez une tache complexe.<br />L'agent planifie, execute et itere automatiquement.</>
                : <>Posez une question sur votre code.<br />Contexte <strong style={{ color: curCtx.color }}>{curCtx.label}</strong> actif. Reponses en streaming.</>
              }
            </div>
          </div>
        ) : messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 8, background: m.role === 'user' ? 'var(--bg-tertiary)' : 'var(--bg-card)', border: m.role === 'assistant' ? '1px solid var(--border)' : 'none' }}>
            <div style={{ fontSize: 8, fontWeight: 700, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3, color: m.role === 'user' ? 'var(--scarlet)' : (PC[activePersona || ''] || '#22c55e') }}>
              {m.role === 'user' ? 'Vous' : (personas.find(p => p.id === activePersona)?.name || 'SpearCode')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
            {m.role === 'assistant' && extractCodeBlocks(m.content).length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {extractCodeBlocks(m.content).map((block, bi) => (
                  <button key={bi} onClick={() => onApplyCode(block.code)}
                    style={{ border: 'none', cursor: 'pointer', borderRadius: 4, padding: '3px 8px', fontSize: 8, fontWeight: 600, background: '#22c55e20', color: '#22c55e', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    Appliquer {block.language ? `(${block.language})` : `bloc ${bi + 1}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {/* Streaming text (live tokens) */}
        {loading && streamingText && (
          <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 8, fontWeight: 700, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.3, color: PC[activePersona || ''] || '#22c55e' }}>
              {personas.find(p => p.id === activePersona)?.name || 'SpearCode'} <span style={{ fontSize: 7, color: 'var(--text-muted)', fontWeight: 400 }}>streaming...</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{streamingText}<span style={{ display: 'inline-block', width: 5, height: 12, background: 'var(--scarlet)', marginLeft: 1, animation: 'pulse 0.6s ease-in-out infinite' }} /></div>
          </div>
        )}
        {/* Agent steps live display */}
        {agentRunning && agentSteps.length > 0 && (
          <div style={{ marginBottom: 6, padding: '6px 10px', borderRadius: 8, background: '#8b5cf608', border: '1px solid #8b5cf630' }}>
            <div style={{ fontSize: 8, fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.3, color: '#8b5cf6', display: 'flex', alignItems: 'center', gap: 4 }}>
              {'\u{1F916}'} Agent Mode <span style={{ fontSize: 7, color: 'var(--text-muted)', fontWeight: 400 }}>etape {agentSteps[agentSteps.length - 1]?.step || '...'}</span>
            </div>
            {agentSteps.map((s, i) => (
              <div key={i} style={{ marginBottom: 4, fontSize: 10, lineHeight: 1.5 }}>
                {s.type === 'thinking' && (
                  <div style={{ color: '#8b5cf6', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#8b5cf6', animation: 'pulse 1s ease-in-out infinite' }} />
                    Etape {s.step}: Reflexion...
                  </div>
                )}
                {s.type === 'tool_call' && (
                  <div style={{ background: '#1e293b', borderRadius: 6, padding: '4px 8px', border: '1px solid #334155' }}>
                    <div style={{ color: '#f59e0b', fontWeight: 700, fontSize: 9 }}>{'\u{1F527}'} {s.tool}({Object.keys(s.args || {}).map(k => `${k}="${String(s.args[k]).substring(0, 30)}"`).join(', ')})</div>
                    {s.reasoning && <div style={{ color: 'var(--text-muted)', fontSize: 9, marginTop: 2 }}>{s.reasoning.substring(0, 120)}</div>}
                  </div>
                )}
                {s.type === 'tool_result' && (
                  <div style={{ background: '#0f172a', borderRadius: 6, padding: '4px 8px', border: '1px solid #1e293b', maxHeight: 80, overflow: 'auto' }}>
                    <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 8 }}>{'\u2705'} Resultat de {s.tool}</div>
                    <pre style={{ margin: 0, fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{(s.result || '').substring(0, 300)}</pre>
                  </div>
                )}
                {s.type === 'response' && (
                  <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>{s.content}</div>
                )}
                {s.type === 'error' && (
                  <div style={{ color: '#dc2626', fontWeight: 600 }}>{'\u274C'} Erreur: {s.error}</div>
                )}
              </div>
            ))}
          </div>
        )}
        {(loading || agentRunning) && !streamingText && !agentRunning && (
          <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--scarlet)', animation: 'pulse 1s ease-in-out infinite' }} />
              Connexion...
            </div>
          </div>
        )}
        {(loading || agentRunning) && (
          <div style={{ padding: '4px 10px', display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={stopGeneration} title="Arreter" style={{
              border: 'none', cursor: 'pointer', padding: '3px 10px', borderRadius: 4,
              background: '#dc262620', color: '#dc2626', fontSize: 9, fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              Stop
            </button>
          </div>
        )}
      </div>

      {/* ── Input ─────────────────────────────────────────────────── */}
      <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {mode === 'agent' && (
          <div style={{ fontSize: 8, color: '#8b5cf6', fontWeight: 600, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
            {'\u{1F916}'} Mode Agent — l'IA va planifier et executer les etapes automatiquement
          </div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <textarea value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mode === 'agent' ? runAgent() : send() } }}
            placeholder={mode === 'agent' ? 'Decrivez la tache a automatiser...' : 'Demandez a SpearCode...'}
            disabled={loading || agentRunning} rows={2}
            style={{
              flex: 1, resize: 'none', padding: '6px 10px', borderRadius: 8,
              background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontSize: 11,
              outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
              border: mode === 'agent' ? '1px solid #8b5cf640' : '1px solid var(--border)',
            }} />
          <button
            onClick={(loading || agentRunning) ? stopGeneration : (mode === 'agent' ? runAgent : send)}
            disabled={!(loading || agentRunning) && !input.trim()}
            title={(loading || agentRunning) ? 'Arreter' : mode === 'agent' ? 'Lancer l\'agent' : 'Envoyer'}
            style={{
              alignSelf: 'flex-end', width: 32, height: 32, borderRadius: 8, border: 'none',
              background: (loading || agentRunning) ? '#dc2626' : input.trim() ? (mode === 'agent' ? '#8b5cf6' : 'var(--scarlet)') : 'var(--bg-tertiary)',
              color: (loading || agentRunning) || input.trim() ? '#fff' : 'var(--text-muted)',
              cursor: (loading || agentRunning) || input.trim() ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}>
            {(loading || agentRunning)
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              : mode === 'agent'
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelRow({ provider, model, shortName, isActive, isFav, onSelect, onToggleFav }: {
  provider: string; model: string; shortName: string; isActive: boolean; isFav: boolean
  onSelect: () => void; onToggleFav: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 10,
        background: isActive ? 'var(--bg-tertiary)' : hovered ? 'var(--bg-tertiary)' : 'transparent',
        borderLeft: isActive ? '2px solid var(--scarlet)' : '2px solid transparent',
        transition: 'background 0.08s',
      }}>
      <button onClick={e => { e.stopPropagation(); onToggleFav() }} title={isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11,
          color: isFav ? '#f59e0b' : 'var(--text-muted)', opacity: isFav ? 1 : hovered ? 0.5 : 0.15,
          transition: 'opacity 0.1s',
        }}>{isFav ? '\u2605' : '\u2606'}</button>
      <span style={{ flex: 1, color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: isActive ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName}</span>
      {isActive && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--scarlet)' }} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODE EDITOR
// ═══════════════════════════════════════════════════════════════════════════════

function CodeEditor({ file, onChange, onSave, onRun, onCursorChange }: {
  file: OpenTab; onChange: (c: string) => void; onSave: () => void; onRun?: () => void; onCursorChange?: (line: number, col: number) => void
}) {
  const lineCountRef = useRef<HTMLDivElement>(null)
  const lines = file.content.split('\n')
  const langColor = LC[file.language] || '#6b7280'

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => { if (lineCountRef.current) lineCountRef.current.scrollTop = e.currentTarget.scrollTop }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') { e.preventDefault(); const ta = e.currentTarget; const s = ta.selectionStart; const end = ta.selectionEnd; onChange(ta.value.substring(0, s) + '  ' + ta.value.substring(end)); requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2 }) }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave() }
  }
  const handleCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget; const before = ta.value.substring(0, ta.selectionStart)
    onCursorChange?.(before.split('\n').length, ta.selectionStart - before.lastIndexOf('\n'))
  }

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
        <div ref={lineCountRef} style={{ width: 44, flexShrink: 0, overflow: 'hidden', padding: '10px 0', background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)', fontFamily: MONO, fontSize: 12, lineHeight: '20px', textAlign: 'right', userSelect: 'none', color: 'var(--text-muted)' }}>
          {lines.map((_, i) => <div key={i} style={{ paddingRight: 8, height: 20, opacity: 0.3 }}>{i + 1}</div>)}
        </div>
        <textarea value={file.content} onChange={e => onChange(e.target.value)}
          onScroll={handleScroll} onKeyDown={handleKeyDown} onClick={handleCursor} onKeyUp={handleCursor} spellCheck={false}
          style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', padding: '10px 14px', fontFamily: MONO, fontSize: 12, lineHeight: '20px', tabSize: 2, background: 'var(--bg-primary)', color: 'var(--text-primary)', overflow: 'auto' }} />
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIFF VIEWER
// ═══════════════════════════════════════════════════════════════════════════════

function DiffViewer({ original, modified, language, fileName }: { original: string; modified: string; language: string; fileName: string }) {
  const oL = original.split('\n'), mL = modified.split('\n'), max = Math.max(oL.length, mL.length)
  const diffs: Array<{ type: 'same' | 'add' | 'remove' | 'change'; ln: number; o?: string; m?: string }> = []
  for (let i = 0; i < max; i++) {
    const o = oL[i], m = mL[i]
    if (o === undefined) diffs.push({ type: 'add', ln: i + 1, m })
    else if (m === undefined) diffs.push({ type: 'remove', ln: i + 1, o })
    else if (o === m) diffs.push({ type: 'same', ln: i + 1, o, m })
    else diffs.push({ type: 'change', ln: i + 1, o, m })
  }
  const added = diffs.filter(d => d.type === 'add' || d.type === 'change').length
  const removed = diffs.filter(d => d.type === 'remove' || d.type === 'change').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ ...S.badge(LC[language] || '#6b7280', true), fontSize: 8 }}>{language}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>Diff: {fileName}</span>
        <div style={{ flex: 1 }} />
        <span style={{ ...S.badge('#22c55e', true), fontSize: 8 }}>+{added}</span>
        <span style={{ ...S.badge('#dc2626', true), fontSize: 8 }}>-{removed}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontFamily: MONO, fontSize: 11, lineHeight: '18px' }}>
        {diffs.map((d, i) => {
          if (d.type === 'same') return <DL key={i} ln={d.ln} text={d.o!} />
          if (d.type === 'remove') return <DL key={i} ln={d.ln} text={d.o!} t="-" />
          if (d.type === 'add') return <DL key={i} ln={d.ln} text={d.m!} t="+" />
          return <div key={i}><DL ln={d.ln} text={d.o!} t="-" /><DL ln={d.ln} text={d.m!} t="+" /></div>
        })}
      </div>
    </div>
  )
}

function DL({ ln, text, t }: { ln: number; text: string; t?: '+' | '-' }) {
  return (
    <div style={{ display: 'flex', padding: '0 12px', background: t === '+' ? '#22c55e12' : t === '-' ? '#dc262612' : 'transparent' }}>
      <span style={{ width: 40, flexShrink: 0, textAlign: 'right', paddingRight: 8, color: t === '+' ? '#22c55e' : t === '-' ? '#dc2626' : 'var(--text-muted)', opacity: 0.4, userSelect: 'none' }}>{ln}</span>
      {t && <span style={{ color: t === '+' ? '#22c55e' : '#dc2626', marginRight: 6, userSelect: 'none' }}>{t}</span>}
      <span style={{ flex: 1, color: t === '+' ? '#4ade80' : t === '-' ? '#f87171' : 'var(--text-muted)', opacity: t ? 1 : 0.5 }}>{text}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-TERMINAL
// ═══════════════════════════════════════════════════════════════════════════════

const TERM_STORAGE_KEY = 'spearcode_terminal'

function loadTermSessions(): { sessions: TermSession[]; active: string; cmdHistory: string[]; nextId: number } | null {
  try {
    const raw = localStorage.getItem(TERM_STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    // Strip streaming flags from restored entries
    if (data.sessions) {
      for (const s of data.sessions) {
        if (s.history) s.history = s.history.map((h: TermEntry) => ({ ...h, streaming: false }))
      }
    }
    return data
  } catch { return null }
}

function saveTermSessions(sessions: TermSession[], active: string, cmdHistory: string[], nextId: number) {
  try {
    // Cap stored history to keep localStorage lean (last 50 entries per session, last 30 AI messages)
    const compact = sessions.map(s => ({
      ...s,
      history: s.history.slice(-50).map(h => ({ ...h, streaming: false })),
      aiHistory: s.aiHistory.slice(-30),
    }))
    localStorage.setItem(TERM_STORAGE_KEY, JSON.stringify({ sessions: compact, active, cmdHistory: cmdHistory.slice(0, 50), nextId }))
  } catch {}
}

function MultiTerminal({ runFile, onClose, filePath }: { runFile?: string; onClose: () => void; filePath?: string }) {
  const savedTerm = useRef(loadTermSessions())
  const [sessions, setSessions] = useState<TermSession[]>(savedTerm.current?.sessions?.length ? savedTerm.current.sessions : [{ id: '1', name: 'Terminal 1', history: [], aiHistory: [] }])
  const [activeSession, setActiveSession] = useState(savedTerm.current?.active || '1')
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [cmdHistory, setCmdHistory] = useState<string[]>(savedTerm.current?.cmdHistory || [])
  const [histIdx, setHistIdx] = useState(-1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nextId = useRef(savedTerm.current?.nextId || 2)
  const abortRef = useRef<AbortController | null>(null)
  const session = sessions.find(s => s.id === activeSession) || sessions[0]

  // Persist terminal sessions on every change
  useEffect(() => {
    saveTermSessions(sessions, activeSession, cmdHistory, nextId.current)
  }, [sessions, activeSession, cmdHistory])

  const addSession = () => { const id = String(nextId.current++); setSessions(prev => [...prev, { id, name: `Terminal ${id}`, history: [], aiHistory: [] }]); setActiveSession(id) }
  const autoScroll = () => requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight))
  const closeSession = (id: string) => {
    setSessions(prev => { const next = prev.filter(s => s.id !== id); if (next.length === 0) { onClose(); return prev } if (activeSession === id) setActiveSession(next[next.length - 1].id); return next })
  }

  // Smart detection: shell command vs natural language AI question
  const detectMode = (text: string): 'shell' | 'ai' => {
    const t = text.trim().toLowerCase()
    // Force shell with $ prefix, force AI with ? prefix
    if (t.startsWith('$')) return 'shell'
    if (t.startsWith('?')) return 'ai'
    // Shell indicators: known commands, paths, pipes, redirects
    const shellStarts = /^(ls|cd|dir|pwd|cat|echo|mkdir|rm|mv|cp|touch|chmod|chown|grep|find|sed|awk|curl|wget|tar|zip|unzip|git|npm|npx|yarn|pnpm|pip|python|python3|node|deno|bun|cargo|go|make|cmake|docker|kubectl|ssh|scp|rsync|which|where|type|set|export|env|source|\.|\.\/|\/|~|sudo|apt|brew|choco|winget|powershell|cmd|exit|clear|cls|ping|netstat|ifconfig|ipconfig|whoami|date|time|head|tail|wc|sort|uniq|tr|cut|xargs|tee|diff|patch|man|help|tree)(\s|$)/
    if (shellStarts.test(t)) return 'shell'
    if (/^[.\/~]/.test(t)) return 'shell'
    if (/[|><]/.test(t) && t.split(' ').length <= 6) return 'shell'
    if (/&&|\|\||;/.test(t)) return 'shell'
    // AI indicators: question marks, French question/action words, long sentences
    if (t.endsWith('?')) return 'ai'
    const aiStarts = /^(comment|pourquoi|quoi|quel|quelle|quels|quelles|est-ce|est ce|peux|peut|pouvez|explique|corrige|montre|aide|ajoute|modifie|cree|genere|ecris|refactorise|optimise|analyse|debug|teste|review|fait|fais|dis|donne|liste|compare|traduis|transforme|supprime|renomme|documente|implement|fix|add|create|write|show|help|explain|find me|how|what|why|where|when|can|could|would|should|please|do|make|update|change|remove|delete|build|run me|tell|describe|is there|are there|j'ai|je veux|je voudrais|il faut|on peut|tu peux)/
    if (aiStarts.test(t)) return 'ai'
    // Heuristic: >5 words without shell chars = probably natural language
    const words = t.split(/\s+/).length
    if (words >= 5 && !/[|><;$`]/.test(t)) return 'ai'
    // Short text with no shell pattern = probably shell
    return 'shell'
  }

  const [inputMode, setInputMode] = useState<'shell' | 'ai'>('shell')
  useEffect(() => { setInputMode(command.trim() ? detectMode(command) : 'shell') }, [command])

  // Streaming AI chat with conversation history per session
  const runAI = async (question: string) => {
    const currentSession = sessions.find(s => s.id === activeSession)!
    const newAiHistory = [...currentSession.aiHistory, { role: 'user', content: question }]

    // Add streaming entry
    const streamEntry: TermEntry = { cmd: question, result: { ok: true, exit_code: 0, stdout: '', stderr: '', elapsed: 0 }, isAI: true, streaming: true }
    setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [...s.history, streamEntry], aiHistory: newAiHistory } : s))
    autoScroll()

    const controller = new AbortController()
    abortRef.current = controller
    const startTime = Date.now()

    try {
      const res = await fetch(`${API}/ai/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, file_path: filePath || null, context_mode: 'smart', history: newAiHistory.slice(-16) }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) throw new Error('Stream non disponible')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.type === 'token') {
              fullText += data.content
              setSessions(prev => prev.map(s => {
                if (s.id !== activeSession) return s
                const hist = [...s.history]
                const last = hist[hist.length - 1]
                if (last?.streaming) hist[hist.length - 1] = { ...last, result: { ...last.result, stdout: fullText } }
                return { ...s, history: hist }
              }))
              autoScroll()
            } else if (data.type === 'error') {
              throw new Error(data.error)
            }
          } catch (e: any) { if (e.message && !e.message.includes('JSON')) throw e }
        }
      }

      const elapsed = (Date.now() - startTime) / 1000
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSession) return s
        const hist = [...s.history]
        const last = hist[hist.length - 1]
        if (last?.streaming) hist[hist.length - 1] = { ...last, streaming: false, result: { ...last.result, stdout: fullText, elapsed } }
        return { ...s, history: hist, aiHistory: [...s.aiHistory, { role: 'assistant', content: fullText }] }
      }))
    } catch (e: any) {
      if (e.name === 'AbortError') return
      // Fallback to non-streaming endpoint
      try {
        const fallback = await apiFetch<{ ok: boolean; response?: string; error?: string }>('/ai/chat', {
          method: 'POST', body: JSON.stringify({ message: question, file_path: filePath || null, context_mode: 'smart', history: newAiHistory.slice(-16) }),
        })
        const elapsed = (Date.now() - startTime) / 1000
        const text = fallback?.ok ? fallback.response! : (fallback?.error || e.message || 'Erreur IA')
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSession) return s
          const hist = [...s.history]
          const last = hist[hist.length - 1]
          if (last?.streaming) hist[hist.length - 1] = { ...last, streaming: false, result: { ok: !!fallback?.ok, exit_code: fallback?.ok ? 0 : 1, stdout: fallback?.ok ? text : '', stderr: fallback?.ok ? '' : text, elapsed } }
          return { ...s, history: hist, aiHistory: fallback?.ok ? [...s.aiHistory, { role: 'assistant', content: text }] : s.aiHistory }
        }))
      } catch {
        const elapsed = (Date.now() - startTime) / 1000
        setSessions(prev => prev.map(s => {
          if (s.id !== activeSession) return s
          const hist = [...s.history]
          const last = hist[hist.length - 1]
          if (last?.streaming) hist[hist.length - 1] = { ...last, streaming: false, result: { ok: false, exit_code: 1, stdout: '', stderr: e.message || 'Erreur IA', elapsed } }
          return { ...s, history: hist }
        }))
      }
    } finally {
      abortRef.current = null
    }
  }

  const run = async (cmd?: string) => {
    const toRun = cmd || command.trim(); if (!toRun || running) return
    setRunning(true); setCmdHistory(prev => [toRun, ...prev.filter(c => c !== toRun)].slice(0, 50)); setHistIdx(-1)

    const mode = detectMode(toRun)
    const cleanCmd = toRun.startsWith('$') ? toRun.substring(1).trim() : toRun.startsWith('?') ? toRun.substring(1).trim() : toRun

    if (mode === 'ai') {
      setCommand('')
      await runAI(cleanCmd)
      setRunning(false); autoScroll()
      return
    }

    const res = await apiFetch<RunResult>('/terminal', { method: 'POST', body: JSON.stringify({ command: cleanCmd, timeout: 30 }) })
    if (res) setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [...s.history, { cmd: toRun, result: res }] } : s))
    setCommand(''); setRunning(false); autoScroll()
  }

  const handleRunFile = async () => {
    if (!runFile) return; setRunning(true)
    const res = await apiFetch<RunResult>('/run', { method: 'POST', body: JSON.stringify({ path: runFile, args: [], timeout: 30 }) })
    if (res) setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [...s.history, { cmd: res.command || `run ${runFile}`, result: res }] } : s))
    setRunning(false); autoScroll()
  }

  const clearSession = () => {
    if (abortRef.current) abortRef.current.abort()
    setSessions(prev => prev.map(s => s.id === activeSession ? { ...s, history: [], aiHistory: [] } : s))
  }

  // Render AI response with markdown formatting (content comes from our own LLM, same pattern as renderMarkdown used elsewhere in this file)
  const renderAIBlock = (text: string, isStreaming?: boolean) => {
    const html = renderMarkdown(text || (isStreaming ? '...' : ''))
    return (
      <div style={{ color: '#c9d1d9', margin: '2px 0 4px', padding: '6px 10px', background: '#131820', borderRadius: 6, borderLeft: '3px solid #8b5cf6', fontSize: 11, lineHeight: 1.6 }}>
        {/* eslint-disable-next-line react/no-danger -- LLM-generated markdown rendered via our own renderMarkdown, not user HTML */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {isStreaming && <span style={{ display: 'inline-block', width: 6, height: 14, background: '#8b5cf6', marginLeft: 2, animation: 'termBlink 1s infinite', verticalAlign: 'text-bottom' }} />}
      </div>
    )
  }

  return (
    <div style={{ height: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', borderTop: '2px solid var(--scarlet)', background: '#0c0f14' }}>
      <style>{`@keyframes termBlink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } } @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', background: '#131820', borderBottom: '1px solid #1e2633', flexShrink: 0 }}>
        {sessions.map(s => (
          <div key={s.id} onClick={() => setActiveSession(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 10, color: s.id === activeSession ? '#c9d1d9' : '#8b949e', borderBottom: s.id === activeSession ? '2px solid var(--scarlet)' : '2px solid transparent' }}>
            <span>{s.name}</span>
            {s.aiHistory.length > 0 && <span style={{ fontSize: 7, color: '#8b5cf6', fontWeight: 700 }}>{Math.floor(s.aiHistory.length / 2)}</span>}
            {sessions.length > 1 && <button onClick={e => { e.stopPropagation(); closeSession(s.id) }} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 9, padding: 0, opacity: 0.4 }}>&times;</button>}
          </div>
        ))}
        <button onClick={addSession} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 12, padding: '4px 8px' }}>+</button>
        <div style={{ flex: 1 }} />
        {runFile && <button onClick={handleRunFile} disabled={running} style={{ ...S.badge('#22c55e', true), border: 'none', fontSize: 9, marginRight: 4 } as any}>{running ? '...' : `Run ${runFile.split('/').pop()}`}</button>}
        {session.aiHistory.length > 0 && <span style={{ fontSize: 8, color: '#8b5cf6', marginRight: 8, opacity: 0.7 }}>{Math.floor(session.aiHistory.length / 2)} echanges</span>}
        <button onClick={clearSession} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 9, marginRight: 4 }}>Clear</button>
        <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#8b949e', cursor: 'pointer', fontSize: 11, marginRight: 8 }}>&times;</button>
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '4px 12px', fontFamily: MONO, fontSize: 11, lineHeight: 1.5 }}>
        {session.history.length === 0 && <div style={{ color: '#8b949e', fontSize: 10, padding: '4px 0', lineHeight: 1.8 }}>Terminal hybride conversationnel.<br /><span style={{ color: '#6b7280' }}>Commandes shell executees normalement. Questions en langage naturel = conversation IA avec memoire de session.<br />Prefixez <span style={{ color: 'var(--scarlet)' }}>$</span> pour forcer shell, <span style={{ color: '#8b5cf6' }}>?</span> pour forcer IA. L'IA se souvient du contexte de cette session.</span></div>}
        {session.history.map((h, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <div>
              <span style={{ color: h.isAI ? '#8b5cf6' : 'var(--scarlet)', fontWeight: 700 }}>{h.isAI ? 'IA' : '~'}</span>
              <span style={{ color: '#8b949e' }}>{h.isAI ? ' > ' : ' $ '}</span>
              <span style={{ color: '#c9d1d9' }}>{h.cmd}</span>
            </div>
            {h.isAI ? (
              h.result.stdout ? renderAIBlock(h.result.stdout, h.streaming) :
              h.result.stderr ? <pre style={{ color: '#f85149', margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>{h.result.stderr}</pre> :
              h.streaming ? renderAIBlock('', true) : null
            ) : (
              <>
                {h.result.stdout && <pre style={{ color: '#c9d1d9', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{h.result.stdout}</pre>}
                {h.result.stderr && <pre style={{ color: '#f85149', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{h.result.stderr}</pre>}
                <div style={{ color: '#8b949e', fontSize: 9 }}><span style={{ color: h.result.ok ? '#22c55e' : '#f85149' }}>{h.result.ok ? '\u2713' : '\u2717'}</span> exit {h.result.exit_code} &mdash; {h.result.elapsed}s</div>
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', borderTop: '1px solid #1e2633', flexShrink: 0 }}>
        <span style={{
          fontFamily: MONO, fontSize: 10, marginRight: 6, fontWeight: 700, minWidth: 20, textAlign: 'center',
          color: inputMode === 'ai' ? '#8b5cf6' : 'var(--scarlet)',
          transition: 'color 0.15s',
        }}>{inputMode === 'ai' ? 'IA' : '~$'}</span>
        <input value={command} onChange={e => setCommand(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') run()
            if (e.key === 'Escape' && running && abortRef.current) { abortRef.current.abort(); setRunning(false) }
            if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.min(histIdx + 1, cmdHistory.length - 1); setHistIdx(n); if (cmdHistory[n]) setCommand(cmdHistory[n]) }
            if (e.key === 'ArrowDown') { e.preventDefault(); const n = Math.max(histIdx - 1, -1); setHistIdx(n); setCommand(n >= 0 ? cmdHistory[n] : '') }
          }}
          placeholder={inputMode === 'ai' ? 'Posez votre question... (contexte de session)' : 'Commande...'}
          disabled={running}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: '#c9d1d9', fontFamily: MONO, fontSize: 11 }} />
        {running && <button onClick={() => { if (abortRef.current) abortRef.current.abort(); setRunning(false) }} style={{ border: 'none', background: 'transparent', color: '#f85149', cursor: 'pointer', fontSize: 9, fontWeight: 700, marginRight: 4 }}>Stop</button>}
        <span style={{ fontSize: 7, fontWeight: 600, color: inputMode === 'ai' ? '#8b5cf6' : '#6b7280', opacity: command.trim() ? 0.8 : 0, transition: 'opacity 0.15s', fontFamily: MONO }}>
          {inputMode === 'ai' ? 'IA' : 'SHELL'}
        </span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERSION PANEL — File history with rollback
// ═══════════════════════════════════════════════════════════════════════════════

interface VersionInfo { version_id: string; timestamp: string; label: string; file_path: string; lines: number; size: number }

function VersionPanel({ filePath, onRestore }: { filePath?: string; onRestore: (content: string) => void }) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// WELCOME SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function WelcomeScreen({ onOpenPalette }: { onOpenPalette: () => void }) {
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

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPPETS PANEL
// ═══════════════════════════════════════════════════════════════════════════════

interface Snippet { id: string; name: string; language: string; code: string; description: string; tags: string[]; created: string }

function SnippetsPanel({ language, onInsert }: { language?: string; onInsert: (code: string) => void }) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [filter, setFilter] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCode, setNewCode] = useState('')
  const [newLang, setNewLang] = useState(language || 'text')
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const data = await apiFetch<{ snippets: Snippet[] }>('/snippets')
    if (data) setSnippets(data.snippets)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const filtered = snippets.filter(s => {
    if (filter && !s.name.toLowerCase().includes(filter.toLowerCase()) && !s.language.includes(filter.toLowerCase())) return false
    return true
  })

  const addSnippet = async () => {
    if (!newName.trim() || !newCode.trim()) return
    await apiFetch('/snippets', { method: 'POST', body: JSON.stringify({ name: newName, code: newCode, language: newLang }) })
    setNewName(''); setNewCode(''); setShowAdd(false); refresh()
  }

  const deleteSnippet = async (id: string) => {
    await apiFetch(`/snippets/${id}`, { method: 'DELETE' })
    refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>Snippets</span>
        <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>({snippets.length})</span>
        <div style={{ flex: 1 }} />
        <IconBtn onClick={() => setShowAdd(!showAdd)} title="Nouveau snippet"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></IconBtn>
      </div>

      {showAdd && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nom du snippet" style={{ width: '100%', padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginBottom: 4 }} />
          <select value={newLang} onChange={e => setNewLang(e.target.value)} style={{ width: '100%', padding: '3px 6px', fontSize: 9, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', marginBottom: 4 }}>
            {['python', 'javascript', 'typescript', 'tsx', 'html', 'css', 'json', 'bash', 'sql', 'rust', 'go', 'java', 'text'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <textarea value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="Code..." rows={4} style={{ width: '100%', padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: MONO, marginBottom: 4 }} />
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={addSnippet} style={{ flex: 1, padding: '4px 0', borderRadius: 4, border: 'none', fontSize: 9, fontWeight: 600, background: '#22c55e', color: '#fff', cursor: 'pointer' }}>Sauvegarder</button>
            <button onClick={() => setShowAdd(false)} style={{ padding: '4px 8px', borderRadius: 4, border: 'none', fontSize: 9, background: 'var(--bg-secondary)', color: 'var(--text-muted)', cursor: 'pointer' }}>Annuler</button>
          </div>
        </div>
      )}

      <div style={{ padding: '4px 10px' }}>
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filtrer snippets..." style={{ width: '100%', padding: '4px 8px', fontSize: 10, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', outline: 'none' }} />
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
            Aucun snippet.{'\n'}Selectionnez du code et utilisez le bouton Snippet.
          </div>
        ) : filtered.map(s => (
          <div key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <div onClick={() => setExpanded(expanded === s.id ? null : s.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 10 }}>
              <span style={{ ...S.badge(LC[s.language] || '#6b7280', true), fontSize: 7, padding: '0 4px' }}>{s.language}</span>
              <span style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <span style={{ fontSize: 7, color: 'var(--text-muted)' }}>{s.code.split('\n').length}L</span>
            </div>
            {expanded === s.id && (
              <div style={{ padding: '0 10px 6px' }}>
                <pre style={{ margin: 0, padding: 6, borderRadius: 4, fontSize: 9, background: '#0c0f14', color: '#c9d1d9', overflow: 'auto', maxHeight: 120, fontFamily: MONO, lineHeight: 1.4, border: '1px solid #1e2633' }}>{s.code}</pre>
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button onClick={() => onInsert(s.code)} style={{ flex: 1, padding: '3px 0', borderRadius: 4, border: 'none', fontSize: 8, fontWeight: 600, background: '#22c55e20', color: '#22c55e', cursor: 'pointer' }}>Inserer</button>
                  <button onClick={() => { navigator.clipboard.writeText(s.code) }} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', fontSize: 8, background: '#3b82f620', color: '#3b82f6', cursor: 'pointer' }}>Copier</button>
                  <button onClick={() => deleteSnippet(s.id)} style={{ padding: '3px 8px', borderRadius: 4, border: 'none', fontSize: 8, background: '#dc262620', color: '#dc2626', cursor: 'pointer' }}>Suppr</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
