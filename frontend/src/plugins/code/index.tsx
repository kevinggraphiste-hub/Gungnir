/**
 * Gungnir Plugin — SpearCode
 *
 * Superior web IDE: command palette, find & replace, minimap, markdown preview,
 * AI code apply, multi-terminal, diff viewer, git integration, status bar.
 * Above Claude Code & OpenCode.
 *
 * Self-contained — no core dependency beyond CSS variables.
 *
 * Ce fichier est désormais un simple compositeur : tous les panneaux et
 * utilitaires vivent dans `components/`, `types.ts`, `utils.ts`, `session.ts`.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import manifest from './manifest.json'
import type { OpenTab, FileData, GitStatus } from './types'
import { apiFetch, IMAGE_EXTS } from './utils'
import { loadSession, saveSession } from './session'

import { HBtn, TabBtn, Breadcrumbs, StatusBar, WelcomeScreen } from './components/common'
import { CommandPalette } from './components/CommandPalette'
import { CodeEditor, FindReplace } from './components/Editor'
import { LivePreview, ImagePreview } from './components/Preview'
import { FileExplorer, SearchPanel } from './components/FileExplorer'
import { GitPanel } from './components/GitPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { AIPanel } from './components/AIChat'
import { DiffViewer } from './components/DiffViewer'
import { MultiTerminal } from './components/MultiTerminal'
import { VersionPanel } from './components/VersionPanel'
import { SnippetsPanel } from './components/SnippetsPanel'

const PLUGIN_VERSION = (manifest as { version?: string }).version || '?'

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

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
  void editorRef
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

  const canRun = activeFile && ['python', 'javascript', 'typescript', 'bash'].includes(activeFile.language)
  const isImage = activeFile?.language === '__image__'
  // Live preview disponible pour les types rendu côté navigateur.
  const previewableLangs = new Set(['markdown', 'html', 'xml', 'svg', 'json', 'css'])
  const canLivePreview = !!(activeFile && previewableLangs.has(activeFile.language))
  const [previewCollapsed, setPreviewCollapsed] = useState(false)

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
        }}>v{PLUGIN_VERSION}</span>

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

        {canLivePreview && <HBtn active={showPreview} onClick={() => { setShowPreview(p => !p); setPreviewCollapsed(false) }} title="Split preview (Ctrl+Shift+P)">
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
                { id: 'refactor', icon: '♻️', label: 'Refactoriser' },
                { id: 'tests', icon: '\u{1F9EA}', label: 'Tests' },
                { id: 'document', icon: '\u{1F4DD}', label: 'Documenter' },
                { id: 'optimize', icon: '⚡', label: 'Optimiser' },
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
              : showPreview && canLivePreview ? (
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <CodeEditor file={activeFile} onChange={c => updateContent(activeFile.path, c)} onSave={() => saveFile(activeFile.path)} onRun={canRun ? () => setShowTerminal(true) : undefined} onCursorChange={(l, c) => updateCursor(activeFile.path, l, c)} />
                  </div>
                  <div style={{ width: 1, background: 'var(--border)' }} />
                  <LivePreview
                    file={activeFile}
                    collapsed={previewCollapsed}
                    onToggleCollapse={() => setPreviewCollapsed(v => !v)}
                    onClose={() => { setShowPreview(false); setPreviewCollapsed(false) }}
                  />
                </div>
              ) : (
                <CodeEditor file={activeFile} onChange={c => updateContent(activeFile.path, c)} onSave={() => saveFile(activeFile.path)} onRun={canRun ? () => setShowTerminal(true) : undefined} onCursorChange={(l, c) => updateCursor(activeFile.path, l, c)} />
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
