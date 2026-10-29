/** Shell terminals of the session directory, several per directory. */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '../../../node_modules/@xterm/xterm/css/xterm.css'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { TERM_CLOSE_PATH, TERM_INPUT_PATH, TERM_OPEN_PATH, TERM_RESIZE_PATH, TERM_STREAM_PATH, type TermEventWire } from '../../protocol.ts'
import { call, message, type TabProps } from './api.tsx'
import css from './Workbench.module.css'

/** Live shells per working directory, kept while the user moves between sessions. */
const terminalIds = new Map<string, string[]>()

function TerminalView({ cwd, tid: knownTid, visible, t, onOpened, onExit }: {
  cwd: string; tid: string | undefined; visible: boolean; t: TabProps['t']; onOpened: (tid: string) => void; onExit: (code: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const fitRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    const element = host.current
    if (element === null) return undefined
    const term = new Terminal({
      fontFamily: 'var(--ds-font-family-code, Menlo, monospace)', fontSize: 13, cursorBlink: true, allowTransparency: true,
      theme: { background: '#00000000', foreground: getComputedStyle(element).color },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(element)
    let tid: string | undefined
    let stream: EventSource | undefined
    let disposed = false
    const fit = (): void => {
      if (element.offsetWidth === 0 || element.offsetHeight === 0) return
      try { fitAddon.fit() } catch { /* not laid out yet */ }
    }
    fitRef.current = fit
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    term.onData((data) => { if (tid !== undefined) void call(TERM_INPUT_PATH, { body: { tid, data } }).catch(() => {}) })
    term.onResize(({ cols, rows }) => { if (tid !== undefined) void call(TERM_RESIZE_PATH, { body: { tid, cols, rows } }).catch(() => {}) })
    const attach = (id: string): void => {
      tid = id
      stream = new EventSource(`${TERM_STREAM_PATH}?tid=${encodeURIComponent(id)}`)
      stream.onmessage = (event: MessageEvent<string>) => {
        const wire = JSON.parse(event.data) as TermEventWire
        if ('data' in wire) term.write(wire.data)
        else { stream?.close(); onExit(wire.exit) }
      }
      void call(TERM_RESIZE_PATH, { body: { tid: id, cols: term.cols, rows: term.rows } }).catch(() => {})
    }
    fit()
    if (knownTid !== undefined) attach(knownTid)
    else {
      void call<{ tid: string }>(TERM_OPEN_PATH, { body: { cwd, cols: term.cols, rows: term.rows } }).then(({ tid: id }) => {
        if (disposed) { void call(TERM_CLOSE_PATH, { body: { tid: id } }).catch(() => {}); return }
        onOpened(id)
        attach(id)
      }, (reason: unknown) => { setError(message(reason)) })
    }
    return () => { disposed = true; observer.disconnect(); stream?.close(); term.dispose(); fitRef.current = undefined }
    // The shell is opened once per mounted view; the props that identify it never change for a given view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (visible) fitRef.current?.() }, [visible])
  void t
  return (
    <div className={css.terminalWrap} hidden={!visible}>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div ref={host} className={css.terminal} data-testid="wb-term-screen" data-tid={knownTid ?? ''} />
    </div>
  )
}

interface Tab { readonly key: number; gen: number; tid: string | undefined; exited: number | undefined }

/** Terminal tab with its own sub-tabs. */
export function TerminalTab({ cwd, active, t }: TabProps) {
  const counter = useRef(0)
  const [tabs, setTabs] = useState<Tab[]>(() => (terminalIds.get(cwd) ?? [undefined]).map(tid => ({ key: counter.current++, gen: 0, tid, exited: undefined })))
  const [current, setCurrent] = useState(0)
  const save = (next: Tab[]): void => { terminalIds.set(cwd, next.flatMap(tab => tab.tid === undefined || tab.exited !== undefined ? [] : [tab.tid])) }
  const update = (key: number, patch: Partial<Tab>): void => {
    setTabs((existing) => { const next = existing.map(tab => tab.key === key ? { ...tab, ...patch } : tab); save(next); return next })
  }
  const add = (): void => {
    const key = counter.current++
    setTabs(existing => [...existing, { key, gen: 0, tid: undefined, exited: undefined }])
    setCurrent(key)
  }
  const close = (tab: Tab): void => {
    if (tab.tid !== undefined) void call(TERM_CLOSE_PATH, { body: { tid: tab.tid } }).catch(() => {})
    setTabs((existing) => {
      const next = existing.filter(other => other.key !== tab.key)
      if (next.length === 0) { const key = counter.current++; const fresh = [{ key, gen: 0, tid: undefined, exited: undefined }]; setCurrent(key); save(fresh); return fresh }
      if (current === tab.key) setCurrent(next[next.length - 1]?.key ?? 0)
      save(next)
      return next
    })
  }
  const shown = tabs.some(tab => tab.key === current) ? current : tabs[0]?.key
  return (
    <div className={css.terminalTabs} data-testid="wb-terminal">
      <div className={css.termBar}>
        {tabs.map((tab, index) => (
          <span key={tab.key} className={tab.key === shown ? css.termTabActive : css.termTab} data-testid="wb-term-tab">
            <button type="button" onClick={() => { setCurrent(tab.key) }}>{t('wb.term.shell', { n: index + 1 })}{tab.exited === undefined ? '' : ` (${tab.exited})`}</button>
            <button type="button" aria-label={t('wb.term.close')} data-testid="wb-term-close" onClick={() => { close(tab) }}>×</button>
          </span>
        ))}
        <Button variant="ghost" size="sm" data-testid="wb-term-add" onClick={add}>＋</Button>
      </div>
      {tabs.map(tab => (
        <div key={tab.key} className={css.termPane} hidden={tab.key !== shown}>
          {tab.exited !== undefined && (
            <p className={css.notice}>
              {t('wb.term.exited', { n: tab.exited })}{' '}
              <Button variant="outline" size="sm" data-testid="wb-term-restart" onClick={() => { update(tab.key, { tid: undefined, exited: undefined, gen: tab.gen + 1 }) }}>{t('wb.term.restart')}</Button>
            </p>
          )}
          <TerminalView
            key={`${tab.key}:${tab.gen}`}
            cwd={cwd} tid={tab.tid} visible={active && tab.key === shown} t={t}
            onOpened={(tid) => { update(tab.key, { tid }) }} onExit={(code) => { update(tab.key, { exited: code }) }}
          />
        </div>
      ))}
    </div>
  )
}
