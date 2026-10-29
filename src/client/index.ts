/**
 * dsh-agent-bridge, browser half. Puts the Claude Code and Codex sessions in the Workspace browser
 * through its external session source when the running browser offers one (the dsh-ui-workspace-hub
 * bundle); otherwise adds a Claude / Codex entry to the sidebar panel list whose page carries its own
 * session list. Either way the session panel opens in the main column, and the configuration page sits
 * on the Plugins page. The session list, transcript and change feed are owned here, in the apply world,
 * so the components only read snapshots.
 * @module dsh-agent-bridge/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ExternalSessionSource } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ARCHIVE_PATH, MANAGE_PATH, NEW_CODEX_SESSION_ID, PIN_PATH, type ManageBodyWire, NEW_SESSION_ID, PANEL_ID, SESSIONS_PATH, type SessionRowWire } from '../protocol.ts'
import { applyEngineMarks } from './branding.tsx'
import { IconChats } from './icons.tsx'
import { endedSince, notifyEnded } from './notify.ts'
import { createSessionsStore, type SessionRow } from './sessions.ts'
import { ExternalPanel } from './ExternalPanel.tsx'
import { EngineMark, graftWorkspaceBrowser, type GraftSlots } from './graft.tsx'
import { createModeStore, withMode } from './mode.tsx'
import { SessionsPage } from './SessionsPage.tsx'
import { SettingsCard, type ExternalEnginesSection } from './SettingsCard.tsx'
import { en, NS, zh, type ExternalEnginesKey } from './locales.ts'
import { createTranscriptController } from './transcript.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Panel and settings-card copy of the agent-bridge plugin. */
    'agent-bridge': ExternalEnginesKey
  }
}

/** Services this plugin requires. */
export const inject = ['slots', 'locale', 'layout', 'configForms', 'uiWorkspace']

/** Entry id of the plugin row the bundle patch inserts; its config is this plugin's settings. */
const ENTRY_ID = 'agent-bridge'
/** Package name keying the bundle's configuration page on the Plugins page. */
const PACKAGE_NAME = 'dsh-agent-bridge'

function toRow(wire: SessionRowWire): SessionRow {
  return { id: wire.id, title: wire.title, cwd: wire.cwd, updatedAt: wire.updatedAt }
}

/**
 * Register the panel-list entry, the page, and the configuration page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  applyEngineMarks(ctx)
  const store = createSessionsStore()
  let defaultCwd = ''
  let wireRows: readonly SessionRow[] = []
  /** Rows created in this page session; kept until the engine lists them (Codex does not list a fork before its first own turn). */
  const created = new Map<string, SessionRow>()
  let codexEnabled = false
  let running = new Set<string>()
  const isZh = (): boolean => ctx.locale.getSnapshot().active.startsWith('zh')
  const draftRows = (): SessionRow[] => [
    { id: NEW_SESSION_ID, title: isZh() ? '＋ 新建 Claude 会话' : '+ New Claude session', cwd: defaultCwd, updatedAt: Date.now() },
    ...codexEnabled ? [{ id: NEW_CODEX_SESSION_ID, title: isZh() ? '＋ 新建 Codex 会话' : '+ New Codex session', cwd: defaultCwd, updatedAt: Date.now() }] : [],
  ]
  const transcript = createTranscriptController({
    onCreated(id, cwd, prompt) {
      const row = { id, title: prompt.slice(0, 80), cwd, updatedAt: Date.now() }
      created.set(id, row)
      wireRows = [row, ...wireRows.filter(existing => existing.id !== id)]
      rows = [...draftRows(), ...wireRows]
      selectedId = id
      publish()
    },
    onTurnEnded() { void refresh() },
    onTurnStarted() { void refresh() },
    onRenamed(id, title) {
      const row = created.get(id)
      if (row !== undefined) created.set(id, { ...row, title })
    },
    onDeleted(id) {
      selectedId = undefined
      dropRow(id)
    },
  })
  let rows: readonly SessionRow[] = []
  let pinned: readonly string[] = []
  let selectedId: string | undefined
  const publish = (): void => {
    store.set({ rows, pinned, ...selectedId === undefined ? {} : { selectedId } })
  }
  /** Remove an archived or deleted row at once; the re-list that follows takes a few seconds with many sessions. */
  const dropRow = (id: string): void => {
    created.delete(id)
    wireRows = wireRows.filter(row => row.id !== id)
    rows = rows.filter(row => row.id !== id)
    publish()
    void refresh()
  }
  const postJson = (path: string, body: unknown): Promise<Response> => fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const pinRow = (id: string, pin: boolean): void => {
    pinned = pin ? [...pinned.filter(other => other !== id), id] : pinned.filter(other => other !== id)
    publish()
    void postJson(PIN_PATH, { id, pinned: pin }).then((response) => {
      if (!response.ok) console.warn('agent-bridge: pin failed', response.status)
      void refresh()
    })
  }
  const archiveRow = (id: string): void => {
    if (selectedId === id) clearSelection()
    void postJson(ARCHIVE_PATH, { id, archived: true }).then((response) => {
      if (response.ok) dropRow(id)
      else console.warn('agent-bridge: archive failed', response.status)
    })
  }
  const renameRow = async (id: string, title: string): Promise<void> => {
    const response = await postJson(MANAGE_PATH, { id, action: 'rename', title } satisfies ManageBodyWire)
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
    const row = created.get(id)
    if (row !== undefined) created.set(id, { ...row, title })
    wireRows = wireRows.map(other => other.id === id ? { ...other, title } : other)
    rows = rows.map(other => other.id === id ? { ...other, title } : other)
    publish()
    void refresh()
  }
  let pendingCwd: string | undefined
  const takePendingCwd = (): string | undefined => { const value = pendingCwd; pendingCwd = undefined; return value }
  const open = (id: string): void => {
    selectedId = id
    publish()
    transcript.open(id)
    ctx.layout.selectPanel(PANEL_ID as MainPanelId)
  }
  const clearSelection = (): void => {
    selectedId = undefined
    transcript.close()
    publish()
  }
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch(SESSIONS_PATH, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { sessions: SessionRowWire[]; running: string[]; pinned?: string[]; defaultCwd: string; codexEnabled: boolean; warnings: string[] }
      const previouslyRunning = running
      running = new Set(body.running)
      for (const id of endedSince(previouslyRunning, running)) {
        const known = [...wireRows, ...rows].find(row => row.id === id)
        notifyEnded((known?.title ?? id).replace(/^▶ /, ''), isZh() ? '回合已结束' : 'The turn has ended')
      }
      defaultCwd = body.defaultCwd
      codexEnabled = body.codexEnabled
      pinned = body.pinned ?? []
      for (const warning of body.warnings) console.warn('agent-bridge:', warning)
      const listed = body.sessions.map(wire => ({ ...toRow(wire), ...running.has(wire.id) ? { title: `▶ ${wire.title}` } : {} }))
      for (const id of [...created.keys()]) if (listed.some(row => row.id === id) && !id.startsWith('codex:')) created.delete(id)
      wireRows = [...[...created.values()].filter(row => !listed.some(item => item.id === row.id)), ...listed]
      rows = [...draftRows(), ...wireRows]
      publish()
    } catch (error) {
      console.warn('agent-bridge: session list failed', error)
    }
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-bridge: dictionaries')
  const t = ctx.locale.bind(NS)
  // The shipped Workspace browser has no external session source; the hub bundle's build adds one.
  const registerSource = (ctx.uiWorkspace as { registerSessionSource?: (source: ExternalSessionSource) => () => void })
    .registerSessionSource
  // Where the rows live: the hub's session source, the shipped browser grafted in place, or our own page.
  const mode = createModeStore(typeof registerSource === 'function' ? 'browser' : 'page')
  if (mode.getSnapshot() === 'browser') {
    ctx.effect(() => registerSource!.call(ctx.uiWorkspace, { snapshot: store, open }), 'agent-bridge: session source')
  } else {
    ctx.effect(() => {
      const graftSlots: GraftSlots = slots
      let undo: (() => void) | undefined
      let removeEntry: (() => void) | undefined
      const tryGraft = (): void => {
        if (undo !== undefined) return
        undo = graftWorkspaceBrowser(graftSlots, { snapshot: store, open, pin: pinRow, archive: archiveRow, rename: renameRow, panelId: PANEL_ID })
        if (undo === undefined) return
        removeEntry?.()
        removeEntry = undefined
        mode.set('browser')
      }
      tryGraft()
      if (undo === undefined) {
        removeEntry = slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID as MainPanelId,
          order: 50,
          label: () => t('list.title'),
          locale: NS,
        }, ({ size }: { size: number }) => IconChats({ size })))
      }
      const unsubscribe = graftSlots.subscribe('sidebar.workspaces', tryGraft)
      return () => {
        unsubscribe()
        removeEntry?.()
        undo?.()
      }
    }, 'agent-bridge: Workspace browser rows or panel list entry')
    ctx.effect(() => slots.inject('sidebar.session.row.leading', () => slots.register({
      name: 'sidebar.session.row.leading',
      id: 'agent-bridge.mark',
      order: -100,
    }, EngineMark)), 'agent-bridge: engine mark on browser rows')
  }
  const scope = ctx.configForms.get<ExternalEnginesSection>(ENTRY_ID)
  const alwaysAllow = async (tool: string): Promise<void> => {
    const current = scope.getSnapshot().value?.allowedTools ?? []
    if (!current.includes(tool)) await scope.set('allowedTools', [...current, tool])
  }
  ctx.effect(() => slots.inject('main', () => slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      hooks: { selection: store, transcript }, controller: transcript, getDefaultCwd: () => defaultCwd, alwaysAllow, clearSelection, openSession: open, takePendingCwd,
      // The frame marks a collapsed sidebar column on its root; ctx.layout only offers the toggle.
      sidebar: { collapsed: () => document.querySelector('[data-sidebar-collapsed]') !== null, toggle: () => { ctx.layout.toggleSidebar() } },
      leave: () => { ctx.layout.selectPanel(null) },
    }),
  }, withMode(mode, ExternalPanel, SessionsPage))), 'agent-bridge: main panel')

  ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: PACKAGE_NAME,
    locale: NS,
    inject: () => ({ hooks: { scope }, save: async (field: string, value: unknown) => { await scope.set(field, value) } }),
  }, SettingsCard)), 'agent-bridge: configuration page')
  ctx.effect(() => () => { transcript.close() }, 'agent-bridge: transcript teardown')
  // Re-list when the row limit changes and when the tab becomes visible again (sessions created in a terminal).
  let lastLimit = scope.getSnapshot().value?.sessionLimit
  ctx.effect(() => scope.subscribe(() => {
    const limit = scope.getSnapshot().value?.sessionLimit
    if (limit === lastLimit) return
    lastLimit = limit
    void refresh()
  }), 'agent-bridge: relist on settings change')
  ctx.effect(() => {
    const timer = window.setInterval(() => { if (running.size > 0) void refresh() }, 4000)
    return () => { window.clearInterval(timer) }
  }, 'agent-bridge: follow running sessions')
  ctx.effect(() => {
    const onNew = (event: Event): void => {
      pendingCwd = (event as CustomEvent<{ cwd: string }>).detail.cwd
      open(NEW_SESSION_ID)
    }
    window.addEventListener('agent-bridge:new-session', onNew)
    return () => { window.removeEventListener('agent-bridge:new-session', onNew) }
  }, 'agent-bridge: new session in a directory')
  ctx.effect(() => {
    const onRefresh = (): void => { void refresh() }
    window.addEventListener('agent-bridge:refresh', onRefresh)
    return () => { window.removeEventListener('agent-bridge:refresh', onRefresh) }
  }, 'agent-bridge: relist on request')
  ctx.effect(() => {
    const onVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, 'agent-bridge: relist on focus')
  void refresh()
}
