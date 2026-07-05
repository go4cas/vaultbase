import { component, html, onCleanup, nextTick } from '@arrow-js/core'
// SQL-only Monaco: the editor core + the SQL grammar, nothing else. Importing
// the umbrella `monaco-editor` drags in ~90 language chunks (13M dist) — dead
// weight in a single-binary embed. Add more `*.contribution` imports if a
// future editor (hooks/JS) needs them. ponytail: SQL is all the spike proves.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

// Vite web-worker wiring for Monaco (the make-or-break for a non-React mount).
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker()
  },
}

let _themed = false
function ensureTheme() {
  if (_themed) return
  _themed = true
  // cogworks-dark — cyanotype palette matching the console.
  monaco.editor.defineTheme('cogworks-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'E8EFF9', background: '0F2547' },
      { token: 'keyword', foreground: 'B6D14A' },
      { token: 'string', foreground: 'A9C0E2' },
      { token: 'number', foreground: 'F5C87A' },
      { token: 'comment', foreground: '5E769B', fontStyle: 'italic' },
      { token: 'operator', foreground: '9FB4D4' },
      { token: 'identifier', foreground: 'E8EFF9' },
    ],
    colors: {
      'editor.background': '#0F2547',
      'editor.foreground': '#E8EFF9',
      'editorLineNumber.foreground': '#3E5C8C',
      'editorLineNumber.activeForeground': '#9FB4D4',
      'editor.selectionBackground': '#2A4A7D80',
      'editor.lineHighlightBackground': '#17335C60',
      'editorCursor.foreground': '#B6D14A',
      'editorWidget.background': '#17335C',
      'editorWidget.border': '#2A4A7D',
      'editorSuggestWidget.background': '#17335C',
      'editorSuggestWidget.selectedBackground': '#2A4A7D',
      'editorSuggestWidget.border': '#2A4A7D',
      'input.background': '#0F2547',
    },
  })
}

let _sqlProvider = false
/** @param {() => string[]} getTables — live table names for completion. */
function ensureSqlCompletion(getTables) {
  if (_sqlProvider) return
  _sqlProvider = true
  const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'JOIN', 'LEFT JOIN', 'ON', 'AND', 'OR', 'AS', 'COUNT', 'DISTINCT', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE']
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      const kw = KEYWORDS.map((k) => ({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range }))
      const tables = getTables().map((t) => ({ label: t, kind: monaco.languages.CompletionItemKind.Struct, insertText: t, detail: 'table', range }))
      return { suggestions: [...tables, ...kw] }
    },
  })
}

let _uid = 0
// Monaco editor mounted the framework-neutral way (core `monaco.editor.create`
// into a DOM ref, disposed on cleanup) — no React wrapper.
export const CodeEditor = component(
  /** @param {{ value?: string, language?: string, height?: number, onChange?: (v: string) => void, tables?: () => string[] }} props */
  ({ value = '', language = 'sql', height = 320, onChange, tables }) => {
  const id = `cw-ed-${++_uid}`
  /** @type {import('monaco-editor').editor.IStandaloneCodeEditor | null} */
  let editor = null
  onCleanup(() => editor?.dispose())

  let disposed = false
  onCleanup(() => { disposed = true })

  // The host div is committed to the live DOM by arrow.js on a later tick than
  // `nextTick` fires, so getElementById races and can miss it. Poll across
  // animation frames until the node is actually connected, then mount once.
  const mount = (/** @type {number} */ attempt = 0) => {
    if (disposed) return
    const el = document.getElementById(id)
    if (!el || !el.isConnected) {
      if (attempt < 60) requestAnimationFrame(() => mount(attempt + 1))
      return
    }
    if (/** @type {any} */ (el).__mounted) return
    /** @type {any} */ (el).__mounted = true
    ensureTheme()
    if (language === 'sql' && tables) ensureSqlCompletion(tables)
    editor = monaco.editor.create(el, {
      value,
      language,
      theme: 'cogworks-dark',
      minimap: { enabled: false },
      fontFamily: "'Space Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 20,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      padding: { top: 12, bottom: 12 },
      renderLineHighlight: 'line',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    })
    if (disposed) { editor.dispose(); editor = null; return }
    if (onChange) editor.onDidChangeModelContent(() => onChange(/** @type {any} */ (editor).getValue()))
  }
  nextTick(() => mount())

  return html`<div id="${id}" style="${`height:${height}px`}" class="overflow-hidden rounded-control border border-line"></div>`
})
