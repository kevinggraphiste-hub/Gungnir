// ── CodeMirror 6 editor ──────────────────────────────────────────────────────
// Remplace le textarea custom par un vrai moteur d'éditeur (syntax highlighting,
// fold, search, multi-cursor, brackets matching, auto-indent, history natifs).

import { useCallback, useEffect, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import type { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { xml } from '@codemirror/lang-xml'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { cpp } from '@codemirror/lang-cpp'
import { oneDark } from '@codemirror/theme-one-dark'
import { showMinimap } from '@replit/codemirror-minimap'
import { languageServer } from 'codemirror-languageserver'
import { getAuthToken } from '@core/services/api'
import { MONO } from '../utils'

// Langages pour lesquels on dispose d'un LSP backend (Phase 1.6-1.8).
// Doit correspondre à LSP_COMMANDS côté backend (plugins/code/lsp/runner.py).
const LSP_SUPPORTED = new Set(['python', 'typescript', 'javascript', 'tsx', 'jsx', 'rust', 'go'])

// Mappe notre `language` vers la clé backend WS (certains langages partagent
// le même serveur : tsx/jsx/typescript/javascript → tsserver).
function lspKey(language: string): string | null {
  if (language === 'python') return 'python'
  if (language === 'rust') return 'rust'
  if (language === 'go') return 'go'
  if (['typescript', 'javascript', 'tsx', 'jsx'].includes(language)) return 'typescript'
  return null
}

// languageId LSP standard (pas la clé WS) — ce que le serveur attend dans
// les messages didOpen.
function lspLanguageId(language: string): string {
  if (language === 'tsx') return 'typescriptreact'
  if (language === 'jsx') return 'javascriptreact'
  return language
}

// Map langage SpearCode → extension CodeMirror
function langExt(language: string) {
  switch (language) {
    case 'python': return python()
    case 'javascript':
    case 'jsx':
      return javascript({ jsx: true })
    case 'typescript':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ jsx: true, typescript: true })
    case 'json': return json()
    case 'html': return html()
    case 'css':
    case 'scss':
      return css()
    case 'markdown': return markdown()
    case 'rust': return rust()
    case 'go': return go()
    case 'php': return php()
    case 'xml':
    case 'vue':
    case 'svg':
      return xml()
    case 'sql': return sql()
    case 'yaml': return yaml()
    case 'cpp':
    case 'c':
    case 'java':
      return cpp()
    default: return null
  }
}

// Thème Gungnir — palette scarlet/dark alignée sur le reste de l'UI.
const gungnirTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
  },
  '.cm-content': {
    fontFamily: MONO,
    padding: '10px 0',
    caretColor: '#dc2626',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#dc2626',
    borderLeftWidth: '2px',
  },
  '.cm-gutters': {
    background: 'var(--bg-secondary)',
    borderRight: '1px solid var(--border)',
    color: 'var(--text-muted)',
    fontFamily: MONO,
  },
  '.cm-activeLineGutter': {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
  },
  '.cm-activeLine': {
    background: 'rgba(220, 38, 38, 0.06)',
  },
  '.cm-selectionMatch': {
    background: 'rgba(220, 38, 38, 0.18)',
  },
  '.cm-searchMatch': {
    background: 'rgba(245, 158, 11, 0.35)',
    outline: '1px solid #f59e0b',
  },
  '.cm-searchMatch-selected': {
    background: 'rgba(220, 38, 38, 0.45)',
  },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    background: 'rgba(220, 38, 38, 0.25)',
    color: 'inherit',
  },
  '.cm-panels': {
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  },
  '.cm-panels .cm-panel': {
    background: 'var(--bg-secondary)',
    borderTop: '1px solid var(--border)',
  },
  '.cm-tooltip': {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
  },
}, { dark: true })

export function CodeMirrorEditor({ value, language, filePath, onChange, onSave, onCursorChange }: {
  value: string
  language: string
  filePath?: string
  onChange: (content: string) => void
  onSave: () => void
  onCursorChange?: (line: number, col: number) => void
}) {
  const ref = useRef<ReactCodeMirrorRef>(null)

  // Keymap Ctrl/Cmd+S — priorité haute pour passer avant les keymaps par défaut.
  const saveKeymap = useMemo(() => Prec.highest(keymap.of([
    { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true } },
  ])), [onSave])

  const extensions = useMemo(() => {
    const minimap = showMinimap.compute(['doc'], () => ({
      create: () => ({ dom: document.createElement('div') }),
      displayText: 'blocks' as const,
      showOverlay: 'always' as const,
    }))
    const ext = [gungnirTheme, saveKeymap, keymap.of([indentWithTab]), EditorView.lineWrapping, minimap]
    const l = langExt(language)
    if (l) ext.push(l)

    // Extension LSP — activée si le langage est supporté côté backend
    // (Phase 1.6-1.8). Le WebSocket pointe vers /api/plugins/code/lsp/{key}
    // avec le token d'auth en query param (les WS ne traversent pas le
    // middleware HTTP — validation manuelle côté backend).
    const key = lspKey(language)
    if (key && LSP_SUPPORTED.has(language) && filePath) {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const tok = getAuthToken() || ''
        const serverUri = `${proto}//${window.location.host}/api/plugins/code/lsp/${key}${tok ? `?token=${encodeURIComponent(tok)}` : ''}` as `ws://${string}` | `wss://${string}`
        const docPath = filePath.startsWith('/') ? filePath : `/${filePath}`
        ext.push(languageServer({
          serverUri,
          rootUri: 'file:///workspace',
          workspaceFolders: [{ name: 'workspace', uri: 'file:///workspace' }],
          documentUri: `file:///workspace${docPath}`,
          languageId: lspLanguageId(language),
        }))
      } catch (e) {
        // Si la lib LSP plante au chargement, on ne veut surtout pas casser
        // l'éditeur — on log et on continue sans LSP.
        console.warn('[SpearCode] LSP extension failed to load:', e)
      }
    }
    return ext
  }, [language, filePath, saveKeymap])

  // Navigation vers une ligne spécifique — déclenchée par OutlinePanel.
  // L'event est global (window) pour éviter de faire remonter la ref de
  // l'éditeur dans les props ; c'est suffisant vu qu'il n'y a qu'un
  // CodeMirrorEditor actif à la fois dans SpearCode.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const line = Number(detail?.line)
      if (!Number.isFinite(line) || line < 1) return
      const view = ref.current?.view
      if (!view) return
      try {
        const doc = view.state.doc
        const target = Math.min(line, doc.lines)
        const pos = doc.line(target).from
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        })
        view.focus()
      } catch { /* ignore */ }
    }
    window.addEventListener('spearcode-goto-line', handler)
    return () => window.removeEventListener('spearcode-goto-line', handler)
  }, [])

  const handleChange = useCallback((v: string) => { onChange(v) }, [onChange])

  const handleStatistics = useCallback((data: { line: { number: number }; selectionAsSingle: { from: number } }) => {
    if (!onCursorChange) return
    const view = ref.current?.view
    if (!view) return
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    onCursorChange(line.number, head - line.from + 1)
  }, [onCursorChange])

  return (
    <CodeMirror
      ref={ref}
      value={value}
      theme={oneDark}
      extensions={extensions}
      onChange={handleChange}
      onStatistics={handleStatistics}
      height="100%"
      style={{ flex: 1, overflow: 'auto', height: '100%' }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        searchKeymap: true,
        history: true,
        drawSelection: true,
        allowMultipleSelections: true,
        indentOnInput: true,
        syntaxHighlighting: true,
        tabSize: 2,
      }}
    />
  )
}
