/** Drawing of one transcript item: Markdown text, folded thinking, checklist, and tool cards. */
import { useState } from 'react'
import { DiffBlock, DisclosureRow, MarkdownText, StateDot, TerminalBlock, type DiffHunk, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TodoWire } from '../protocol.ts'
import type { TimelineItem } from './timeline.ts'
import css from './ToolCard.module.css'

/** Translator the panel passes down. */
export type Translate = PropsLocale<'agent-bridge'>['t']

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

const COMMAND_TOOLS = new Set(['Bash', 'command'])
const LINE_CAP = 40

/** Pull a string argument. */
function arg(args: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = args?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * One-line description of a tool call.
 * @param name - tool name.
 * @param args - structured input, when the engine supplied it.
 * @param fallback - text summary of the input.
 * @returns the text shown beside the tool name.
 */
export function summarizeTool(name: string, args: Readonly<Record<string, unknown>> | undefined, fallback: string): string {
  const pick = COMMAND_TOOLS.has(name)
    ? arg(args, 'description') ?? arg(args, 'command')
    : arg(args, 'file_path') ?? arg(args, 'path') ?? arg(args, 'pattern') ?? arg(args, 'url') ?? arg(args, 'query')
      ?? arg(args, 'description') ?? arg(args, 'prompt') ?? arg(args, 'command')
  return (pick ?? fallback).split('\n')[0] ?? ''
}

/** Edits of one Edit, MultiEdit, or Write call as diff hunks. */
function hunksOf(name: string, args: Readonly<Record<string, unknown>> | undefined): DiffHunk[] | undefined {
  const path = arg(args, 'file_path')
  if (path === undefined) return undefined
  if (name === 'Write') return [{ path, oldText: null, newText: arg(args, 'content') ?? '' }]
  if (name === 'Edit') return [{ path, oldText: arg(args, 'old_string') ?? '', newText: arg(args, 'new_string') ?? '' }]
  if (name === 'MultiEdit' && Array.isArray(args?.['edits'])) {
    return (args['edits'] as Array<Record<string, unknown>>).map(edit => ({
      path, oldText: String(edit['old_string'] ?? ''), newText: String(edit['new_string'] ?? ''),
    }))
  }
  return undefined
}

export function DiffText({ text }: { text: string }) {
  return (
    <pre className={css.pre}>
      {text.split('\n').map((line, index) => (
        <span key={index} className={line.startsWith('+') ? css.add : line.startsWith('-') ? css.del : undefined}>{line}{'\n'}</span>
      ))}
    </pre>
  )
}

function ToolBody({ item, t }: { item: ToolItem; t: Translate }) {
  const { use, result } = item
  const name = use?.name ?? ''
  const hunks = hunksOf(name, use?.args)
  const resultText = result?.text ?? ''
  if (COMMAND_TOOLS.has(name) && use !== undefined) {
    return (
      <TerminalBlock
        command={arg(use.args, 'command') ?? use.input} output={resultText} running={result === undefined}
        {...result === undefined ? {} : { exitCode: result.isError === true ? 1 : 0 }} maxLines={LINE_CAP} labels={terminalLabels(t)}
      />
    )
  }
  if (hunks !== undefined) {
    return (
      <>
        <DiffBlock diffs={hunks} labels={diffLabels(t)} maxLines={LINE_CAP} />
        {result?.isError === true && <p className={css.err}>{resultText}</p>}
      </>
    )
  }
  if (name === 'fileChange') return <DiffText text={resultText} />
  return (
    <>
      {use !== undefined && <pre className={css.pre}>{use.input}</pre>}
      {resultText !== '' && <pre className={css.pre} data-testid="ext-tool-result">{resultText}</pre>}
    </>
  )
}

function terminalLabels(t: Translate) {
  return {
    commandLine: (line: number) => t('block.commandLine', { n: line }),
    signal: (signal: string) => signal,
    exitCode: (code: number) => t('block.exitCode', { n: code }),
    noExitCode: t('block.noExitCode'),
    running: t('block.running'), failed: t('block.failed'), done: t('block.done'),
    copy: t('block.copy'), copied: t('block.copied'), noOutput: t('block.noOutput'),
    collapseAria: t('block.collapse'), collapse: t('block.collapse'),
    expandAria: (hidden: number) => t('block.expand', { n: hidden }), expand: (hidden: number) => t('block.expand', { n: hidden }),
  }
}

function diffLabels(t: Translate) {
  return {
    copy: t('block.copy'), copied: t('block.copied'), collapseAria: t('block.collapse'), collapse: t('block.collapse'),
    expandAria: (hidden: number) => t('block.expand', { n: hidden }), expand: (hidden: number) => t('block.expand', { n: hidden }),
    files: (count: number) => t('block.files', { n: count }),
    codeLabel: t('block.code'), wrapLabel: t('block.wrap'), unwrapLabel: t('block.unwrap'),
  }
}

/**
 * Markdown body of a message.
 * @param props - text, translator, and whether the text is still being written.
 * @returns rendered Markdown.
 */
export function Markdown({ text, t, streaming = false }: { text: string; t: Translate; streaming?: boolean }) {
  return (
    <div className={css.markdown}>
      <MarkdownText text={text} streaming={streaming} labels={{ code: { copyLabel: t('block.copy'), copiedLabel: t('block.copied') }, footnotes: t('block.footnotes') }} />
    </div>
  )
}

/**
 * Checklist of a todo call.
 * @param props - the items.
 * @returns the list.
 */
export function Todos({ todos }: { todos: readonly TodoWire[] }) {
  return (
    <ul className={css.todos} data-testid="ext-todos">
      {todos.map((todo, index) => (
        <li key={index} data-status={todo.status} className={todo.status === 'completed' ? css.todoDone : undefined}>
          {todo.status === 'completed' ? '☑' : '☐'} {todo.content}
        </li>
      ))}
    </ul>
  )
}

/**
 * Folded model thinking.
 * @param props - thinking text and translator.
 * @returns a collapsed row that opens to Markdown.
 */
export function Thinking({ text, t }: { text: string; t: Translate }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.thinking} data-testid="ext-thinking">
      <DisclosureRow icon={<StateDot state="idle" />} title={t('panel.thinking')} open={open} expandable onToggle={() => { setOpen(!open) }} expandOnRowClick>
        <Markdown text={text} t={t} />
      </DisclosureRow>
    </div>
  )
}

/**
 * Tool call folded into one row that opens to its input and output.
 * @param props - the call with its result, translator, and whether the turn is still running.
 * @returns the card.
 */
export function ToolCard({ item, t, running }: { item: ToolItem; t: Translate; running: boolean }) {
  const [open, setOpen] = useState(false)
  const [zoom, setZoom] = useState<string | undefined>(undefined)
  const { use, result } = item
  const state: StateDotState = result?.isError === true ? 'error' : result !== undefined ? 'done' : running ? 'ongoing' : 'idle'
  const name = use?.name ?? t('panel.toolResult')
  const summary = use === undefined ? (result?.text ?? '').split('\n')[0] ?? '' : summarizeTool(use.name, use.args, use.input)
  return (
    <div className={css.tool} data-testid="ext-tool-use" data-tool={name} data-state={state}>
      <DisclosureRow
        icon={<StateDot state={state} />} title={`${name}  ${summary}`} open={open} expandable
        onToggle={() => { setOpen(!open) }} expandOnRowClick titleClassName={css.toolTitle}
      >
        <div className={css.toolBody}><ToolBody item={item} t={t} /></div>
      </DisclosureRow>
      {result?.images?.map((src, index) => (
        <img key={index} className={css.thumb} data-testid="ext-image" src={src} alt={t('panel.image')} onClick={() => { setZoom(src) }} />
      ))}
      {zoom !== undefined && (
        <div className={css.zoom} data-testid="ext-zoom" role="dialog" onClick={() => { setZoom(undefined) }}>
          <img src={zoom} alt={t('panel.image')} />
        </div>
      )}
    </div>
  )
}
