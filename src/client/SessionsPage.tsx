/**
 * The Claude / Codex page: the session list grouped by working directory beside the open session.
 * While the page shows, the core sidebar column is collapsed so the list takes its place.
 * @module dsh-agent-bridge/SessionsPage
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CODEX_ID_PREFIX } from '../protocol.ts'
import { ExternalPanel, type ExternalPanelProps } from './ExternalPanel.tsx'
import { IconSearch } from './icons.tsx'
import { groupByFolder, type SessionRow } from './sessions.ts'
import { isDraft } from './transcript.ts'
import css from './SessionsPage.module.css'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact age, in the sidebar's style (`5m`, `14h`, `3d`, `2mo`). */
function age(updatedAt: number, now: number): string {
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d`
  return `${Math.floor(elapsed / (30 * DAY))}mo`
}

function SessionItem({ row, selected, level, now, onOpen }: {
  row: SessionRow; selected: boolean; level: number; now: number; onOpen: (id: string) => void
}) {
  const engine = row.id.startsWith(CODEX_ID_PREFIX) ? 'codex' : 'claude'
  return (
    <li
      role="treeitem" aria-level={level} aria-selected={selected} tabIndex={-1} data-id={row.id}
      className={selected ? `${css.item} ${css.selected}` : css.item}
      onClick={() => { onOpen(row.id) }}
      onKeyDown={(event) => { if (event.key === 'Enter') onOpen(row.id) }}
    >
      <span data-engine={engine} />
      <span className={css.itemTitle} title={row.title}>{row.title}</span>
      {!isDraft(row.id) && <span className={css.age}>{age(row.updatedAt, now)}</span>}
    </li>
  )
}

/** Whether the core sidebar is collapsed because this page collapsed it. */
const SIDEBAR_FLAG = 'agent-bridge:sidebar-collapsed-by-page'

function readFlag(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_FLAG) === '1' } catch { return false /* storage blocked: the sidebar is left as the user has it */ }
}

function writeFlag(on: boolean): void {
  try { if (on) window.localStorage.setItem(SIDEBAR_FLAG, '1'); else window.localStorage.removeItem(SIDEBAR_FLAG) } catch { /* storage blocked: a reload on this page then leaves the sidebar collapsed */ }
}

/**
 * Render the list column and the session panel.
 * @param props - the main-panel props shared with {@link ExternalPanel}.
 * @returns the page.
 */
export function SessionsPage(props: ExternalPanelProps) {
  const { t, useSelection, openSession, sidebar, leave } = props
  const rows = useSelection(snapshot => snapshot.rows)
  const selectedId = useSelection(snapshot => snapshot.selectedId)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const drafts = rows.filter(row => isDraft(row.id))
  const groups = useMemo(() => groupByFolder(rows.filter(row => !isDraft(row.id)), query), [rows, query])
  const now = Date.now()
  // Collapse the core sidebar on entry and reopen it on exit, unless the user reopened it meanwhile.
  // Runs on mount and unmount only: the injected object is rebuilt on every render. The flag survives a
  // reload on this page, so the sidebar this page collapsed is reopened even after the app restarts.
  const sidebarRef = useRef(sidebar)
  useEffect(() => {
    const column = sidebarRef.current
    const owned = column.collapsed() ? readFlag() : (column.toggle(), true)
    if (!owned) return undefined
    writeFlag(true)
    return () => {
      writeFlag(false)
      if (column.collapsed()) column.toggle()
    }
  }, [])
  const toggle = (cwd: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(cwd)) next.add(cwd)
      return next
    })
  }
  return (
    <div className={css.page} data-testid="ext-page">
      <nav className={css.list} aria-label={t('list.title')} data-testid="ext-list">
        <div className={css.head}>
          <button type="button" className={css.back} data-testid="ext-list-back" aria-label={t('list.back')} title={t('list.back')} onClick={leave}>
            <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          </button>
          <span>{t('list.title')}</span>
        </div>
        <label className={css.search}>
          <IconSearch size={14} />
          <input data-testid="ext-list-search" value={query} placeholder={t('list.search')} aria-label={t('list.search')} onChange={(event) => { setQuery(event.target.value) }} />
        </label>
        <ul role="tree" className={css.tree} aria-label={t('list.title')}>
          {drafts.map(row => <SessionItem key={row.id} row={row} selected={row.id === selectedId} level={1} now={now} onOpen={openSession} />)}
          {groups.flatMap(group => [
            <li
              key={`folder:${group.cwd}`} role="treeitem" aria-level={1} aria-expanded={!collapsed.has(group.cwd)} tabIndex={-1}
              className={css.folder} title={group.cwd} data-testid="ext-folder"
              onClick={() => { toggle(group.cwd) }}
              onKeyDown={(event) => { if (event.key === 'Enter') toggle(group.cwd) }}
            >
              <span className={css.caret} aria-hidden="true">{collapsed.has(group.cwd) ? '▸' : '▾'}</span>
              <span className={css.itemTitle}>{group.label}</span>
            </li>,
            ...collapsed.has(group.cwd) ? [] : group.rows.map(row => (
              <SessionItem key={row.id} row={row} selected={row.id === selectedId} level={2} now={now} onOpen={openSession} />
            )),
          ])}
        </ul>
        {groups.length === 0 && <p className={css.empty}>{query.trim() === '' ? t('list.none') : t('list.noMatch')}</p>}
      </nav>
      <div className={css.main}>
        <ExternalPanel {...props} />
      </div>
    </div>
  )
}
