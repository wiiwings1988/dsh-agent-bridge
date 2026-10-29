/**
 * Puts the Claude Code and Codex rows into the shipped dsh Workspace browser without replacing it. The
 * browser's registration stays the one ui-workspace made (so its child slots, inject face, store and
 * dictionary keep working); only the component it renders is wrapped, and the wrapper hands the shipped
 * component a session list, workspace list, panel state and open action with the external rows merged in.
 * Session row entries are wrapped the same way: on an external row, pin, archive and rename run against the
 * plugin's sessions and every other Host verb renders nothing. The rename dialog the browser raises is
 * wrapped so it renames an external row through the plugin.
 *
 * This reaches into the slot ledger, which is not a published contract: every probe is checked, a shape
 * that does not match leaves the browser alone (the caller then shows its own sessions page), and a
 * wrapper that throws falls back to rendering the shipped component untouched.
 * @module dsh-agent-bridge/client/graft
 */
import { Component, createElement, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Prefix of external row ids in the browser; Host SessionIds never carry it. */
export const EXTERNAL_PREFIX = 'ext:'

/** One external row as the browser lists it. */
export interface GraftRow {
  readonly id: string
  readonly title: string
  readonly cwd: string
  readonly updatedAt: number
}

/** Rows, the pinned rows, and the row the external panel shows. */
export interface GraftSnapshot {
  readonly rows: readonly GraftRow[]
  /** Ids of pinned rows (without the browser prefix). */
  readonly pinned?: readonly string[]
  readonly selectedId?: string
}

/** What the plugin hands the graft. Every id is a row id without the browser prefix. */
export interface GraftSource {
  readonly snapshot: HostObservable<GraftSnapshot>
  /** Show a row. */
  open(id: string): void
  /** Pin or unpin a row. */
  pin(id: string, pinned: boolean): void
  /** Archive a row. */
  archive(id: string): void
  /** Rename a row; rejects with the reason the dialog shows. */
  rename(id: string, title: string): Promise<void>
  /** Main panel id the external session page occupies. */
  readonly panelId: string
}

/** One registration as the slot ledger stores it. */
interface LedgerEntry {
  component: unknown
  options?: { readonly id?: string | undefined } | undefined
  children?: Readonly<Record<string, unknown>> | undefined
}

/** The slot ledger surface the graft needs (ctx.slots). */
export interface GraftSlots {
  entries(key: string): readonly LedgerEntry[]
  subscribe(key: string, listener: () => void): () => void
}

const BROWSER_SLOT = 'sidebar.workspaces'
const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
const ACTION_SLOT = 'sidebar.workspaces.session.row.action'
const LEADING_SLOT = 'sidebar.session.row.leading'
const HOVER_SLOT = 'sidebar.session.row.hover'
const OVERLAY_SLOT = 'shell.overlay'
/** The browser's rename dialog in `shell.overlay`. */
const RENAME_DIALOG_ID = 'workspace.session-rename'
/** Row slots whose entries act on Host Sessions; their entries render nothing on an external row. */
const HOST_ROW_SLOTS = [MENU_SLOT, ACTION_SLOT, LEADING_SLOT, HOVER_SLOT]

/** Marks a row entry this plugin registers itself, which the graft leaves unwrapped. */
export const OWN_ROW_ENTRY = Symbol.for('agent-bridge.row-entry')

/**
 * Whether a browser row id is one of ours.
 * @param id - browser row id.
 * @returns true for prefixed ids.
 */
export function isExternalId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(EXTERNAL_PREFIX)
}

/**
 * Engine of a browser row, for its mark.
 * @param id - browser row id.
 * @returns `dsh`, or the engine namespace of an external id (`ext:<engine>:…`).
 */
export function engineOf(id: string): string {
  if (!isExternalId(id)) return 'dsh'
  const rest = id.slice(EXTERNAL_PREFIX.length)
  const end = rest.indexOf(':')
  return end > 0 ? rest.slice(0, end) : 'external'
}

type SessionSummaryLike = { id: string; retainedBy?: Record<string, number | undefined> } & Record<string, unknown>
type SessionListLike = { ids: readonly string[]; byId: Record<string, SessionSummaryLike> } & Record<string, unknown>
type WorkspaceLike = { path?: string; sessionIds?: readonly string[] } & Record<string, unknown>

/**
 * Host Session list with the external rows appended. While the external panel shows a row, that row is the
 * one the main view retains, so the browser's own highlight rule selects it.
 * @param list - Host Session list snapshot.
 * @param external - external rows and selection.
 * @param externalShown - whether the external panel is the active main panel.
 * @returns `list` itself when nothing changes, otherwise a merged copy.
 */
export function mergeList(list: SessionListLike, external: GraftSnapshot, externalShown: boolean): SessionListLike {
  if (external.rows.length === 0 && !externalShown) return list
  const ids = [...list.ids]
  const byId: Record<string, SessionSummaryLike> = { ...list.byId }
  if (externalShown) {
    for (const id of ids) {
      const row = byId[id]
      if ((row?.retainedBy?.['mainView'] ?? 0) > 0) byId[id] = { ...row!, retainedBy: { ...row!.retainedBy, mainView: 0 } }
    }
  }
  for (const row of external.rows) {
    const id = EXTERNAL_PREFIX + row.id
    byId[id] = {
      id,
      title: row.title,
      displayTitle: row.title,
      cwd: row.cwd,
      running: false,
      retainedBy: externalShown && row.id === external.selectedId ? { mainView: 1 } : {},
      blank: false,
      updatedAt: row.updatedAt,
    }
    ids.push(id)
  }
  return { ...list, ids, byId }
}

/**
 * Account external rows to the Workspace whose path is their directory.
 * @param items - Host Workspace projections.
 * @param external - external rows.
 * @returns `items` itself when no row matches, otherwise copies with the rows appended.
 */
export function mergeWorkspaces(items: readonly WorkspaceLike[], external: GraftSnapshot): readonly WorkspaceLike[] {
  if (external.rows.length === 0) return items
  let changed = false
  const next = items.map((workspace) => {
    const extra = external.rows.filter(row => row.cwd === workspace.path).map(row => EXTERNAL_PREFIX + row.id)
    if (extra.length === 0) return workspace
    changed = true
    return { ...workspace, sessionIds: [...workspace.sessionIds ?? [], ...extra] }
  })
  return changed ? next : items
}

/**
 * Workspace snapshot with the external rows accounted to their Workspaces and the pinned ones added to the pin set.
 * @param state - Host Workspace snapshot.
 * @param external - external rows and pins.
 * @returns `state` itself when nothing changes, otherwise a merged copy.
 */
export function mergeWorkspaceState<S extends { items: readonly WorkspaceLike[]; pinnedSessionIds?: readonly string[] }>(
  state: S,
  external: GraftSnapshot,
): S {
  const items = mergeWorkspaces(state.items, external)
  const pins = (external.pinned ?? []).map(id => EXTERNAL_PREFIX + id)
  if (items === state.items && pins.length === 0) return state
  return { ...state, items, ...pins.length === 0 ? {} : { pinnedSessionIds: [...state.pinnedSessionIds ?? [], ...pins] } }
}

type Selector<S> = <R>(select: (state: S) => R) => R
type BrowserProps = {
  useSessions?: Selector<SessionListLike>
  useWorkspaces?: Selector<{ items: readonly WorkspaceLike[]; pinnedSessionIds?: readonly string[] } & Record<string, unknown>>
  usePanelInfo?: Selector<{ activePanelId: string | null } & Record<string, unknown>>
  open?: (id: string) => void
} & Record<string, unknown>

/** Renders `fallback` instead of `children` once `children` threw. */
class Fallback extends Component<{ fallback: () => ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.warn('agent-bridge: the merged Workspace browser failed, showing the shipped one', error)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback() : this.props.children
  }
}

function wrapBrowser(Shipped: ComponentType<BrowserProps>, source: GraftSource): ComponentType<BrowserProps> {
  const subscribe = (listener: () => void): (() => void) => source.snapshot.subscribe(listener)
  const getSnapshot = (): GraftSnapshot => source.snapshot.getSnapshot()
  function Merged(props: BrowserProps): ReactNode {
    const external = useSyncExternalStore(subscribe, getSnapshot)
    const { useSessions, useWorkspaces, usePanelInfo, open } = props
    const externalShown = usePanelInfo === undefined ? false : usePanelInfo(info => info.activePanelId) === source.panelId
    const merged = useMemo((): BrowserProps => {
      const next: BrowserProps = { ...props }
      if (useSessions !== undefined) {
        next.useSessions = <R,>(select: (state: SessionListLike) => R): R => {
          const list = useSessions(state => state)
          const mergedList = useMemo(() => mergeList(list, external, externalShown), [list, external, externalShown])
          return select(mergedList)
        }
      }
      if (useWorkspaces !== undefined) {
        next.useWorkspaces = <R,>(select: (state: { items: readonly WorkspaceLike[]; pinnedSessionIds?: readonly string[] } & Record<string, unknown>) => R): R => {
          const state = useWorkspaces(value => value)
          const mergedState = useMemo(() => mergeWorkspaceState(state, external), [state, external])
          return select(mergedState)
        }
      }
      if (usePanelInfo !== undefined) {
        // Our panel highlights its row through the merged list, so the browser sees no foreign panel.
        next.usePanelInfo = <R,>(select: (info: { activePanelId: string | null } & Record<string, unknown>) => R): R => {
          const info = usePanelInfo(value => value)
          const shown = useMemo(() => info.activePanelId === source.panelId ? { ...info, activePanelId: null } : info, [info])
          return select(shown)
        }
      }
      if (open !== undefined) {
        next.open = (id: string) => {
          if (isExternalId(id)) source.open(id.slice(EXTERNAL_PREFIX.length))
          else open(id)
        }
      }
      return next
    }, [props, external, externalShown])
    return createElement(Fallback, { fallback: () => createElement(Shipped, props), children: createElement(Shipped, merged) })
  }
  Merged.displayName = 'ExternalEnginesWorkspaceBrowser'
  return Merged
}

type RowProps = { sessionId?: string } & Record<string, unknown>
const NO_IDS: ReadonlySet<string> = new Set()
const pinSets = new WeakMap<readonly string[], ReadonlySet<string>>()

/** Pinned browser row ids of the external snapshot, one Set per published pin list. */
function pinnedSet(snapshot: GraftSnapshot): ReadonlySet<string> {
  const pinned = snapshot.pinned
  if (pinned === undefined) return NO_IDS
  let set = pinSets.get(pinned)
  if (set === undefined) {
    set = new Set(pinned.map(id => EXTERNAL_PREFIX + id))
    pinSets.set(pinned, set)
  }
  return set
}

/**
 * Props that point a shipped row entry at the plugin on an external row, by the entry's registration id.
 * Entries without an adapter render nothing there.
 */
function rowAdapters(source: GraftSource): Record<string, (props: RowProps) => RowProps> {
  const raw = (id: unknown): string => String(id).slice(EXTERNAL_PREFIX.length)
  const subscribe = (listener: () => void): (() => void) => source.snapshot.subscribe(listener)
  const usePinned = <R,>(select: (set: ReadonlySet<string>) => R): R =>
    select(useSyncExternalStore(subscribe, () => pinnedSet(source.snapshot.getSnapshot())))
  // Archived external rows are not listed, so every listed row reads as not archived.
  const useArchived = <R,>(select: (set: ReadonlySet<string>) => R): R => select(NO_IDS)
  const pin = (props: RowProps): RowProps => ({
    ...props,
    usePinned,
    useArchived,
    pinSession: (id: string) => { source.pin(raw(id), true) },
    unpinSession: (id: string) => { source.pin(raw(id), false) },
  })
  return {
    pin,
    archive: props => ({ ...props, useArchived, archiveSession: (id: string) => { source.archive(raw(id)) }, unarchiveSession: () => {} }),
    // The shipped item only raises the rename dialog, which the overlay wrapper routes to the plugin.
    rename: props => props,
  }
}

function wrapRowEntry(
  Shipped: ComponentType<RowProps>,
  adapt: ((props: RowProps) => RowProps) | undefined,
): ComponentType<RowProps> {
  function ExternalAware(props: RowProps): ReactNode {
    if (!isExternalId(props.sessionId)) return createElement(Shipped, props)
    return adapt === undefined ? null : createElement(Shipped, adapt(props))
  }
  ExternalAware.displayName = 'ExternalEnginesRowEntry'
  return ExternalAware
}

function wrapRenameDialog(Shipped: ComponentType<RowProps>, source: GraftSource): ComponentType<RowProps> {
  function ExternalRename(props: RowProps): ReactNode {
    const renameSession = props['renameSession'] as ((id: string, title: string) => Promise<void>) | undefined
    // The dialog reads renameSession only when the operator confirms, so a fresh function per render is harmless.
    if (renameSession === undefined) return createElement(Shipped, props)
    return createElement(Shipped, {
      ...props,
      renameSession: (id: string, title: string) => isExternalId(id)
        ? source.rename(id.slice(EXTERNAL_PREFIX.length), title)
        : renameSession(id, title),
    })
  }
  ExternalRename.displayName = 'ExternalEnginesRenameDialog'
  return ExternalRename
}

/**
 * Wrap the shipped browser and its row verbs, now and whenever they register again (hot reload, plugin
 * reload). Returns undefined when the ledger does not look like the dsh 0.2.1 browser.
 * @param slots - the client slot registry.
 * @param source - external rows, open action and panel id.
 * @returns disposer restoring every wrapped component, or undefined when the graft does not apply.
 */
export function graftWorkspaceBrowser(slots: GraftSlots, source: GraftSource): (() => void) | undefined {
  if (typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return undefined
  const isShippedBrowser = (entry: LedgerEntry): boolean =>
    typeof entry.component === 'function' && entry.children?.[MENU_SLOT] !== undefined
  if (!slots.entries(BROWSER_SLOT).some(isShippedBrowser)) return undefined
  const adapters = rowAdapters(source)
  const restore = new Map<LedgerEntry, unknown>()
  const wrap = (key: string, make: (shipped: never, entry: LedgerEntry) => unknown, accept: (entry: LedgerEntry) => boolean): void => {
    for (const entry of slots.entries(key)) {
      if (restore.has(entry) || !accept(entry)) continue
      const shipped = entry.component
      entry.component = make(shipped as never, entry)
      restore.set(entry, shipped)
    }
  }
  const sync = (): void => {
    wrap(BROWSER_SLOT, (shipped: ComponentType<BrowserProps>) => wrapBrowser(shipped, source), isShippedBrowser)
    for (const key of HOST_ROW_SLOTS) {
      wrap(key, (shipped: ComponentType<RowProps>, entry) => wrapRowEntry(shipped, adapters[entry.options?.id ?? '']),
        entry => typeof entry.component === 'function' && !(OWN_ROW_ENTRY in entry.component))
    }
    wrap(OVERLAY_SLOT, (shipped: ComponentType<RowProps>) => wrapRenameDialog(shipped, source),
      entry => typeof entry.component === 'function' && entry.options?.id === RENAME_DIALOG_ID)
  }
  sync()
  const unsubscribe = [BROWSER_SLOT, ...HOST_ROW_SLOTS, OVERLAY_SLOT].map(key => slots.subscribe(key, sync))
  return () => {
    for (const off of unsubscribe) off()
    for (const [entry, shipped] of restore) entry.component = shipped
    restore.clear()
  }
}

/**
 * Leading-cell mark of a session row: the engine that owns it.
 * @param props - the row's Session identity.
 * @param props.sessionId - browser row id.
 * @returns the mark span the engine-mark stylesheet draws.
 */
export const EngineMark = Object.assign(
  ({ sessionId }: { sessionId: string }): ReactNode => createElement('span', { 'data-engine': engineOf(sessionId), 'aria-hidden': true }),
  { [OWN_ROW_ENTRY]: true, displayName: 'ExternalEnginesMark' },
)
