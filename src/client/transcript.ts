/**
 * Browser-side owner of one external session's transcript, change feed, and live turn.
 * Lives in the apply world so the panel component only reads a snapshot. The transcript file is the
 * source of truth: live events only trigger refetches and show what has not been written yet.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  ANSWER_PATH, ARCHIVE_PATH, INTERRUPT_PATH, LIVE_PATH, MANAGE_PATH, NEW_CODEX_SESSION_ID, NEW_SESSION_ID, SEND_PATH, SESSION_PATH, WATCH_PATH,
  type AnswerBodyWire, type GoalWire, type LiveEventWire, type ManageBodyWire, type MessageWire, type PermissionWire, type SendBodyWire, type SessionWire, type UsageWire, type AttachmentWire,
} from '../protocol.ts'

/** Transcript and live-turn state the panel renders. */
export interface TranscriptState {
  readonly status: 'idle' | 'loading' | 'ready' | 'failed'
  readonly sessionId?: string
  readonly messages: readonly MessageWire[]
  /** True once the session file changed elsewhere after the transcript was loaded. */
  readonly staleElsewhere: boolean
  /** True while a turn started from this browser or another is running. */
  readonly running: boolean
  /** Assistant text streamed so far and not yet in the file. */
  readonly partial: string
  /** Prompt just sent and not yet in the file. */
  readonly pendingUser?: string | undefined
  readonly permissions: readonly PermissionWire[]
  /** Active /goal read from the transcript file. */
  readonly goal?: GoalWire | undefined
  /** Token totals of the session, when the engine records them. */
  readonly usage?: UsageWire | undefined
  /** Number of recent turns shown when older ones were left out. */
  readonly recentTurns?: number | undefined
  readonly error?: string | undefined
}

/** Observable session owner. */
export interface TranscriptController extends HostObservable<TranscriptState> {
  /**
   * Show a session (or the new-session draft) and follow it.
   * @param sessionId - external session id, or the draft id.
   */
  open(sessionId: string): void
  /** Reload the open session and clear the stale flag. */
  reload(): void
  /** Close every feed and return to idle. */
  close(): void
  /**
   * Send a user message; creates the session when the draft is open.
   * @param text - the message.
   * @param cwd - working directory for a new session.
   * @param extras - model, effort and attachments of this turn.
   */
  send(text: string, cwd: string, extras?: SendExtras): Promise<void>
  /** Move the open session out of the list (it can be restored from the settings card). */
  archive(): Promise<void>
  /**
   * Answer a pending permission request or question.
   * @param requestId - request id.
   * @param behavior - allow or deny.
   * @param answers - AskUserQuestion answers keyed by question text.
   * @param remember - keep the approval for the rest of the session (Codex).
   */
  answer(requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string>, remember?: boolean): Promise<void>
  /** Interrupt the running turn. */
  interrupt(): Promise<void>
  /**
   * Fork, rename, or delete the open session.
   * @param action - the operation.
   * @param title - new title for `rename`.
   */
  manage(action: ManageBodyWire['action'], title?: string): Promise<void>
}

/** Per-turn choices that ride along with a message. */
export interface SendExtras {
  readonly model?: string
  readonly effort?: string
  readonly attachments?: readonly AttachmentWire[]
}

/** Callbacks into the plugin entry. */
export interface TranscriptHooks {
  /** A send on the draft created this session. */
  onCreated(id: string, cwd: string, prompt: string): void
  /** A turn ended or the stored sessions changed; the session list should be refreshed. */
  onTurnEnded(): void
  /** A turn was accepted by the host; the list should show it as running. */
  onTurnStarted(): void
  /** The open session was deleted. */
  onDeleted(id: string): void
  /** The open session was renamed. */
  onRenamed(id: string, title: string): void
}

/** @param id - external session id. @returns whether it is a new-session draft. */
export function isDraft(id: string | undefined): boolean {
  return id === NEW_SESSION_ID || id === NEW_CODEX_SESSION_ID
}

const IDLE: TranscriptState = Object.freeze({
  status: 'idle', messages: [], staleElsewhere: false, running: false, partial: '', permissions: [],
})

async function post(path: string, body: unknown): Promise<Response> {
  return await fetch(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

/**
 * Create a session owner.
 * @param hooks - callbacks into the plugin entry.
 * @returns the controller.
 */
export function createTranscriptController(hooks: TranscriptHooks): TranscriptController {
  let state: TranscriptState = IDLE
  let watch: EventSource | undefined
  let live: EventSource | undefined
  let generation = 0
  let pendingBase = 0
  const listeners = new Set<() => void>()
  const publish = (next: TranscriptState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  const patch = (changes: Partial<TranscriptState>): void => { publish({ ...state, ...changes }) }
  const query = (id: string): string => `?id=${encodeURIComponent(id)}`
  const closeFeeds = (): void => {
    watch?.close()
    live?.close()
    watch = undefined
    live = undefined
  }

  const fetchMessages = async (id: string, mine: number): Promise<boolean> => {
    const response = await fetch(`${SESSION_PATH}${query(id)}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as SessionWire
    if (mine !== generation) return false
    const written = body.messages.length > pendingBase
    patch({ status: 'ready', messages: body.messages, goal: body.goal, usage: body.usage, recentTurns: body.recentTurns, ...written ? { pendingUser: undefined } : {} })
    return true
  }
  const startWatch = (id: string, mine: number): void => {
    watch?.close()
    const opened = new EventSource(`${WATCH_PATH}${query(id)}`)
    watch = opened
    opened.onmessage = () => {
      if (mine === generation && !state.running) patch({ staleElsewhere: true })
    }
  }
  const settle = async (id: string, mine: number): Promise<void> => {
    try {
      if (await fetchMessages(id, mine)) startWatch(id, mine)
    } catch (error) {
      console.warn('agent-bridge: transcript load failed', error)
    }
  }
  const startLive = (id: string, mine: number): void => {
    live?.close()
    const opened = new EventSource(`${LIVE_PATH}${query(id)}`)
    live = opened
    opened.onmessage = (message: MessageEvent<string>) => {
      if (mine !== generation) return
      const event = JSON.parse(message.data) as LiveEventWire
      switch (event.kind) {
        case 'idle':
          if (state.running) {
            patch({ running: false, partial: '', pendingUser: undefined, permissions: [] })
            hooks.onTurnEnded()
            void settle(id, mine)
          }
          break
        case 'delta':
          patch({ running: true, partial: state.partial + event.text })
          break
        case 'message':
          patch({ running: true, partial: '' })
          void fetchMessages(id, mine).catch(() => {})
          break
        case 'permission':
          patch({ running: true, permissions: [...state.permissions.filter(p => p.requestId !== event.permission.requestId), event.permission] })
          break
        case 'permission_done':
          patch({ permissions: state.permissions.filter(p => p.requestId !== event.requestId) })
          break
        case 'ended':
          patch({
            running: false, partial: '', pendingUser: undefined, permissions: [],
            ...event.status === 'error' ? { error: event.error ?? 'error' } : {},
          })
          hooks.onTurnEnded()
          void settle(id, mine)
          break
      }
    }
  }
  const load = (id: string): void => {
    generation += 1
    const mine = generation
    closeFeeds()
    pendingBase = 0
    if (isDraft(id)) {
      publish({ ...IDLE, status: 'ready', sessionId: id })
      return
    }
    publish({ ...IDLE, status: 'loading', sessionId: id })
    startLive(id, mine)
    void fetchMessages(id, mine)
      .then((ok) => { if (ok) startWatch(id, mine) })
      .catch((error: unknown) => {
        if (mine !== generation) return
        console.warn('agent-bridge: transcript load failed', error)
        patch({ status: 'failed' })
      })
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: load,
    reload() {
      if (state.sessionId !== undefined) load(state.sessionId)
    },
    close() {
      generation += 1
      closeFeeds()
      publish(IDLE)
    },
    async send(text, cwd, extras) {
      const current = state.sessionId
      if (current === undefined || state.running) return
      const draft = isDraft(current)
      pendingBase = state.messages.length
      patch({ running: true, pendingUser: text, partial: '', error: undefined })
      try {
        const body: SendBodyWire = { ...draft ? { text, cwd, engine: current === NEW_CODEX_SESSION_ID ? 'codex' : 'claude' } : { id: current, text, ...cwd === '' ? {} : { cwd } }, ...extras }
        const response = await post(SEND_PATH, body)
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`)
        const { id } = await response.json() as { id: string }
        hooks.onTurnStarted()
        if (draft) {
          const mine = generation
          hooks.onCreated(id, cwd, text)
          if (mine === generation) {
            patch({ sessionId: id })
            startLive(id, mine)
          }
        }
      } catch (error) {
        patch({ running: false, pendingUser: undefined, error: error instanceof Error ? error.message : String(error) })
      }
    },
    async answer(requestId, behavior, answers, remember) {
      if (state.sessionId === undefined) return
      const body: AnswerBodyWire = {
        id: state.sessionId, requestId, behavior,
        ...answers === undefined ? {} : { answers }, ...remember === true ? { remember } : {},
      }
      await post(ANSWER_PATH, body)
    },
    async manage(action, title) {
      const current = state.sessionId
      if (current === undefined || isDraft(current) || state.running) return
      const body: ManageBodyWire = { id: current, action, ...title === undefined ? {} : { title } }
      const response = await post(MANAGE_PATH, body)
      if (!response.ok) {
        patch({ error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}` })
        return
      }
      if (action === 'fork') {
        const { id } = await response.json() as { id: string }
        hooks.onCreated(id, '', title ?? '')
        load(id)
      } else if (action === 'delete') {
        generation += 1
        closeFeeds()
        publish(IDLE)
        hooks.onDeleted(current)
      } else {
        hooks.onRenamed(current, title ?? '')
        hooks.onTurnEnded()
      }
    },
    async archive() {
      const current = state.sessionId
      if (current === undefined || isDraft(current) || state.running) return
      const response = await post(ARCHIVE_PATH, { id: current, archived: true })
      if (!response.ok) { patch({ error: `HTTP ${response.status}` }); return }
      generation += 1
      closeFeeds()
      publish(IDLE)
      hooks.onDeleted(current)
    },
    async interrupt() {
      if (state.sessionId === undefined) return
      await post(INTERRUPT_PATH, { id: state.sessionId })
    },
  }
}
