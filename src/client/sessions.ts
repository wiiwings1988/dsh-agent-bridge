/**
 * Session rows of the Claude / Codex page: the observable list the page renders and its grouping by
 * working directory.
 * @module dsh-agent-bridge/sessions
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** One listed session, or one of the two draft rows that start a new session. */
export interface SessionRow {
  readonly id: string
  readonly title: string
  /** Working directory the session runs in. */
  readonly cwd: string
  /** Last activity, in epoch milliseconds. */
  readonly updatedAt: number
}

/** What the page renders: every row and the open one. */
export interface SessionsSnapshot {
  readonly rows: readonly SessionRow[]
  /** Ids of the rows pinned in the Workspace browser. */
  readonly pinned?: readonly string[]
  readonly selectedId?: string
}

/** Observable list that the apply world writes and the page reads. */
export interface SessionsStore extends HostObservable<SessionsSnapshot> {
  set(next: SessionsSnapshot): void
}

/**
 * Create an empty store.
 * @returns the store.
 */
export function createSessionsStore(): SessionsStore {
  let snapshot: SessionsSnapshot = { rows: [] }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Sessions sharing one working directory. */
export interface FolderGroup {
  readonly cwd: string
  /** Last path segment, or the whole path when it has none. */
  readonly label: string
  /** Newest first. */
  readonly rows: readonly SessionRow[]
}

/**
 * Group sessions by working directory, keeping only those whose title or directory contains the query
 * (case-insensitive). Groups are ordered by their newest session, newest first.
 * @param rows - listed sessions, without draft rows.
 * @param query - search text; blank keeps every row.
 * @returns the non-empty groups.
 */
export function groupByFolder(rows: readonly SessionRow[], query: string): FolderGroup[] {
  const needle = query.trim().toLowerCase()
  const groups = new Map<string, SessionRow[]>()
  for (const row of rows) {
    if (needle !== '' && !row.title.toLowerCase().includes(needle) && !row.cwd.toLowerCase().includes(needle)) continue
    const list = groups.get(row.cwd)
    if (list === undefined) groups.set(row.cwd, [row])
    else list.push(row)
  }
  return [...groups].map(([cwd, list]) => ({
    cwd,
    label: cwd.split('/').filter(part => part !== '').at(-1) ?? cwd,
    rows: list.toSorted((a, b) => b.updatedAt - a.updatedAt),
  })).toSorted((a, b) => (b.rows[0]?.updatedAt ?? 0) - (a.rows[0]?.updatedAt ?? 0))
}
