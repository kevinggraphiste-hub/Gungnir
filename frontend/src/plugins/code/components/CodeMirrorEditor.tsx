// ── CodeMirror 6 editor ──────────────────────────────────────────────────────
// Remplace le textarea custom par un vrai moteur d'éditeur (syntax highlighting,
// fold, search, multi-cursor, brackets matching, auto-indent, history natifs).

import { useCallback, useMemo, useRef } from 'react'
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
import { MONO } from '../utils'

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

export function CodeMirrorEditor({ value, language, onChange, onSave, onCursorChange }: {
  value: string
  language: string
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
    const ext = [gungnirTheme, saveKeymap, keymap.of([indentWithTab]), EditorView.lineWrapping]
    const l = langExt(language)
    if (l) ext.push(l)
    return ext
  }, [language, saveKeymap])

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
