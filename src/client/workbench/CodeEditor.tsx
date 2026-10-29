/** CodeMirror editor with syntax highlighting; the document is owned by the editor until `docKey` changes. */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css as cssLang } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { sql } from '@codemirror/lang-sql'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import styles from './Workbench.module.css'

/** @returns the language support for a path, or none. */
export function languageFor(path: string): Extension | undefined {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return javascript({ typescript: true })
    case 'tsx': return javascript({ typescript: true, jsx: true })
    case 'js': case 'mjs': case 'cjs': return javascript()
    case 'jsx': return javascript({ jsx: true })
    case 'json': case 'jsonc': return json()
    case 'css': return cssLang()
    case 'html': case 'htm': case 'vue': return html()
    case 'md': case 'markdown': return markdown()
    case 'py': return python()
    case 'yml': case 'yaml': return yaml()
    case 'xml': case 'svg': case 'plist': return xml()
    case 'sql': return sql()
    case 'rs': return rust()
    case 'c': case 'h': case 'cc': case 'cpp': case 'hpp': return cpp()
    case 'java': return java()
    case 'go': return go()
    default: return undefined
  }
}

function palette(dark: boolean): HighlightStyle {
  const c = dark
    ? { keyword: '#c792ea', string: '#c3e88d', number: '#f78c6c', comment: '#7f8a9a', fn: '#82aaff', type: '#ffcb6b', tag: '#f07178' }
    : { keyword: '#7c3aed', string: '#15803d', number: '#c2410c', comment: '#6b7280', fn: '#1d4ed8', type: '#a16207', tag: '#be123c' }
  return HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: c.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: c.string },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: c.number },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c.comment, fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: c.fn },
    { tag: [tags.typeName, tags.className, tags.namespace], color: c.type },
    { tag: [tags.tagName, tags.heading, tags.link], color: c.tag },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
  ])
}

const isDark = (element: HTMLElement): boolean => {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(element).color)
  // Light text means a dark surface.
  return match !== null && (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000 > 140
}

/** Editor props. */
export interface CodeEditorProps {
  readonly docKey: string
  readonly path: string
  readonly initial: string
  readonly onChange: (text: string) => void
  readonly onSave: () => void
}

/**
 * Mount a CodeMirror view for one document.
 * @param props - document identity, initial text, and callbacks.
 * @returns the editor host element.
 */
export function CodeEditor({ docKey, path, initial, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const save = useRef(onSave)
  const change = useRef(onChange)
  save.current = onSave
  change.current = onChange
  useEffect(() => {
    const element = host.current
    if (element === null) return undefined
    const language = new Compartment()
    const lang = languageFor(path)
    const view = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(), highlightActiveLine(), history(), bracketMatching(), indentOnInput(), highlightSelectionMatches(),
          syntaxHighlighting(palette(isDark(element))),
          language.of(lang ?? []),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { save.current(); return true } },
            indentWithTab, ...searchKeymap, ...historyKeymap, ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => { if (update.docChanged) change.current(update.state.doc.toString()) }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'transparent', color: 'inherit' },
            '.cm-scroller': { fontFamily: 'var(--ds-font-family-code, monospace)', lineHeight: '1.5' },
            '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--dsw-alias-label-tertiary, #888)', border: 'none' },
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgb(120 120 120 / 10%)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-cursor': { borderLeftColor: 'currentcolor' },
          }),
        ],
      }),
    })
    return () => { view.destroy() }
    // A new document key means a new document; the initial text is only read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])
  return <div ref={host} className={styles.cm} data-testid="wb-editor" data-path={path} />
}
