/**
 * Turns of Claude Code sessions run through the Claude Agent SDK. One `query()` per user message,
 * resumed by session id, so a Host restart loses only the live turn; the transcript file stays the
 * source of truth.
 */
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { query, type Options, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeConfigDir } from './claude.ts'
import { modelLabel, readClaudeEffortSetting } from './defaults.ts'
import { LiveHub } from './live.ts'
import type { InfoWire, PermissionWire, QuestionWire } from './protocol.ts'
import type { Subscriber } from './live.ts'

/** Options of one turn. */
export interface TurnOptions {
  readonly sessionId?: string
  readonly cwd: string
  readonly text: string
  readonly executable: string
  readonly permissionMode: PermissionMode
  readonly allowedTools: readonly string[]
  /** Offer the Peekaboo screen-control MCP server. */
  readonly computerUse: boolean
  readonly peekabooCommand: string
  /** Offer the Playwright browser MCP server; `browserHeaded` shows its window. */
  readonly browserUse?: boolean
  readonly browserHeaded?: boolean
  /** dsh memory text appended to the system prompt; empty adds nothing. */
  readonly memory: string
  /** Model and reasoning effort; undefined uses the engine default. */
  readonly model?: string
  readonly effort?: string
  /** Images embedded in the message. */
  readonly images?: readonly { readonly mime: string; readonly base64: string }[]
}

type Decision = { readonly behavior: 'allow'; readonly answers?: Readonly<Record<string, string>> } | { readonly behavior: 'deny' }

interface Run {
  readonly query: Query
  readonly pending: Map<string, (decision: Decision) => void>
  interrupted: boolean
}

/** MCP server name of the screen-control tools this plugin adds. */
export const SCREEN_SERVER = 'peekaboo-dsh'

/** MCP server name of the browser tools this plugin adds. */
export const BROWSER_SERVER = 'playwright-dsh'

/** Pinned so a new upstream release cannot change what runs on this machine. */
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.83'

/** Browser tools that only read the page and are approved without asking. */
const BROWSER_READ_ONLY = ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests']

/** Read-only screen tools approved without asking; every other tool of the server asks each time. */
const SCREEN_READ_ONLY = ['see', 'image', 'capture', 'inspect_ui', 'verify_state', 'permissions', 'sleep']

/**
 * Peekaboo tools that send screenshots to an external model (`analyze`, `agent`), plus the same tools of the
 * user-level `peekaboo` server; they conflict with keeping screen content on this machine.
 */
const SCREEN_DISALLOWED = ['analyze', 'agent'].flatMap(tool => [`mcp__${SCREEN_SERVER}__${tool}`, `mcp__peekaboo__${tool}`])

/** Environment of the Claude process; the macOS keychain lookup of the login needs USER, which a sanitized launcher drops. */
function childEnv(): Record<string, string | undefined> {
  const name = userInfo().username
  return { ...process.env, USER: process.env['USER'] ?? name, LOGNAME: process.env['LOGNAME'] ?? name }
}

function toQuestions(input: Record<string, unknown>): QuestionWire[] {
  const raw = Array.isArray(input['questions']) ? input['questions'] as Array<Record<string, unknown>> : []
  return raw.map(item => ({
    question: String(item['question'] ?? ''),
    header: String(item['header'] ?? ''),
    multiSelect: item['multiSelect'] === true,
    options: (Array.isArray(item['options']) ? item['options'] as Array<Record<string, unknown>> : [])
      .map(option => ({ label: String(option['label'] ?? ''), description: String(option['description'] ?? '') })),
  }))
}

function baseOptions(options: TurnOptions): Options {
  return {
    cwd: options.cwd,
    ...options.sessionId === undefined ? {} : { resume: options.sessionId },
    pathToClaudeCodeExecutable: options.executable,
    permissionMode: options.permissionMode,
    allowedTools: [
      ...options.allowedTools,
      ...options.computerUse ? SCREEN_READ_ONLY.map(tool => `mcp__${SCREEN_SERVER}__${tool}`) : [],
      ...options.browserUse === true ? BROWSER_READ_ONLY.map(tool => `mcp__${BROWSER_SERVER}__${tool}`) : [],
    ],
    disallowedTools: SCREEN_DISALLOWED,
    ...options.computerUse || options.browserUse === true
      ? {
        mcpServers: {
          ...options.computerUse ? { [SCREEN_SERVER]: { type: 'stdio' as const, command: options.peekabooCommand, args: ['mcp', '--no-remote'] } } : {},
          ...options.browserUse === true
            ? { [BROWSER_SERVER]: { type: 'stdio' as const, command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--isolated', ...options.browserHeaded === true ? [] : ['--headless']] } }
            : {},
        },
      }
      : {},
    ...options.memory === '' ? {} : { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: `# Memory shared from dsh\n${options.memory}` } },
    ...options.model === undefined || options.model === '' ? {} : { model: options.model },
    ...isEffort(options.effort) ? { effort: options.effort } : {},
    settingSources: ['user', 'project', 'local'],
    env: childEnv(),
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const isEffort = (value: string | undefined): value is typeof EFFORTS[number] => EFFORTS.includes(value as typeof EFFORTS[number])

/** The prompt of a turn: plain text, or a one-message stream when images are attached. */
export function promptOf(options: Pick<TurnOptions, 'text' | 'images'>): string | AsyncIterable<SDKUserMessage> {
  if (options.images === undefined || options.images.length === 0) return options.text
  const content = [
    ...options.images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mime as 'image/png', data: image.base64 } })),
    { type: 'text' as const, text: options.text },
  ]
  return (async function* () {
    yield { type: 'user' as const, message: { role: 'user' as const, content }, parent_tool_use_id: null }
  })()
}

/** What the Claude executable offers for a working directory. */
export async function probeInfo(options: TurnOptions): Promise<InfoWire> {
  const stream = query({ prompt: 'ok', options: { ...baseOptions({ ...options, text: 'ok' }), persistSession: false } })
  try {
    for await (const message of stream) {
      if (message.type !== 'system' || message.subtype !== 'init') continue
      const [models, commands, mcp, account] = await Promise.all([
        stream.supportedModels(), stream.supportedCommands(), stream.mcpServerStatus(), stream.accountInfo().catch(() => undefined),
      ])
      const listed = models.map(model => ({
        value: model.value, name: model.displayName, description: model.description,
        efforts: model.supportsEffort === true ? model.supportedEffortLevels ?? [] : [],
      }))
      // The probe passes no model or effort when none is picked, so init reports what Claude Code chose by itself.
      const effort = message.effort ?? readClaudeEffortSetting(claudeConfigDir())
      return {
        models: listed,
        defaults: { model: modelLabel(message.model, listed), ...effort === undefined || effort === null ? {} : { effort } },
        commands: commands.map(command => ({ name: command.name, description: command.description, argumentHint: command.argumentHint })),
        mcp: mcp.map(server => ({
          name: server.name, status: server.status,
          ...server.scope === undefined ? {} : { scope: server.scope }, ...server.error === undefined ? {} : { error: server.error },
          ...server.tools === undefined ? {} : { tools: server.tools.length },
        })),
        ...account === undefined ? {} : { account: { loggedIn: account.email !== undefined || account.apiProvider !== undefined || account.tokenSource !== undefined || account.apiKeySource !== undefined,
          ...account.email === undefined ? {} : { email: account.email },
          ...account.subscriptionType === undefined ? {} : { plan: account.subscriptionType },
          ...account.apiProvider === undefined ? {} : { provider: account.apiProvider } } },
      }
    }
    throw new Error('no init message')
  } finally {
    stream.close()
  }
}

/** Result of starting a session only far enough to read its tool and MCP server lists. */
export interface ToolProbe {
  readonly tools: readonly string[]
  readonly mcpServers: readonly { readonly name: string; readonly status: string }[]
}

/**
 * Start a throwaway turn, read the tools and MCP server states from its init message, and stop it.
 * @param options - the options a real turn would use (the text is ignored).
 * @returns the tool names and MCP server states.
 */
export async function probeTools(options: TurnOptions): Promise<ToolProbe> {
  const stream = query({ prompt: 'ok', options: { ...baseOptions({ ...options, text: 'ok' }), persistSession: false } })
  try {
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        return { tools: message.tools, mcpServers: message.mcp_servers.map(server => ({ name: server.name, status: server.status })) }
      }
    }
    throw new Error('no init message')
  } finally {
    stream.close()
  }
}

/** Owns the running turns and the subscribers watching them. */
export class RunManager {
  private readonly runs = new Map<string, Run>()
  private readonly hub = new LiveHub()

  /**
   * Start a turn. Resolves once the session id is known (immediately for a resumed session).
   * @param options - turn options.
   * @returns the session id.
   */
  async start(options: TurnOptions): Promise<string> {
    if (options.sessionId !== undefined && this.runs.has(options.sessionId)) throw new Error('a turn is already running in this session')
    let current: Run | undefined
    let resolveId!: (id: string) => void
    let rejectId!: (error: Error) => void
    const idPromise = new Promise<string>((resolve, reject) => { resolveId = resolve; rejectId = reject })
    const stream = query({
      prompt: promptOf(options),
      options: {
        ...baseOptions(options),
        includePartialMessages: true,
        canUseTool: (tool, input, context) => this.ask(current, resolvedId(), tool, input, context.title ?? tool, context.signal),
      },
    })
    let sessionId = options.sessionId
    const resolvedId = (): string => sessionId ?? ''
    current = { query: stream, pending: new Map(), interrupted: false }
    if (sessionId !== undefined) {
      this.runs.set(sessionId, current)
      this.hub.begin(sessionId)
      resolveId(sessionId)
    }
    void this.pump(current, stream, (id) => {
      sessionId = id
      this.runs.set(id, current as Run)
      this.hub.begin(id)
      resolveId(id)
    }, resolvedId, rejectId)
    return await idPromise
  }

  private async pump(run: Run, stream: Query, onId: (id: string) => void, idOf: () => string, fail: (error: Error) => void): Promise<void> {
    let status: 'ok' | 'error' | 'interrupted' = 'ok'
    let error: string | undefined
    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (idOf() === '') onId(message.session_id)
        } else if (message.type === 'stream_event') {
          const event = message.event as { type?: string; delta?: { type?: string; text?: string } }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            this.hub.emit(idOf(), { kind: 'delta', text: event.delta.text ?? '' })
          }
        } else if (message.type === 'assistant' || message.type === 'user') {
          this.hub.emit(idOf(), { kind: 'message' })
        } else if (message.type === 'result' && message.is_error) {
          status = 'error'
          error = 'result' in message ? String(message.result) : message.subtype
        }
      }
    } catch (caught) {
      status = 'error'
      error = caught instanceof Error ? caught.message : String(caught)
    }
    if (run.interrupted) status = 'interrupted'
    const id = idOf()
    if (id === '') {
      fail(new Error(error ?? 'the turn ended before the session started'))
      return
    }
    this.hub.emit(id, error === undefined ? { kind: 'ended', status } : { kind: 'ended', status, error })
    this.runs.delete(id)
    this.hub.end(id)
  }

  private ask(run: Run | undefined, sessionId: string, tool: string, input: Record<string, unknown>, title: string, signal: AbortSignal): Promise<
    { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string }
  > {
    if (run === undefined) return Promise.resolve({ behavior: 'deny', message: 'no run' })
    const requestId = randomUUID()
    const questions = tool === 'AskUserQuestion' ? toQuestions(input) : undefined
    const plan = tool === 'ExitPlanMode' && typeof input['plan'] === 'string' ? input['plan'] : undefined
    const text = JSON.stringify(input)
    const permission: PermissionWire = {
      requestId, tool, title,
      input: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      ...plan === undefined ? {} : { plan },
      ...questions === undefined ? {} : { questions },
    }
    return new Promise((resolve) => {
      const finish = (decision: Decision): void => {
        if (!run.pending.delete(requestId)) return
        this.hub.emit(sessionId, { kind: 'permission_done', requestId })
        if (decision.behavior === 'deny') resolve({ behavior: 'deny', message: 'The user declined this request.' })
        else resolve({ behavior: 'allow', ...decision.answers === undefined ? {} : { updatedInput: { ...input, answers: decision.answers } } })
      }
      run.pending.set(requestId, finish)
      signal.addEventListener('abort', () => finish({ behavior: 'deny' }), { once: true })
      this.hub.emit(sessionId, { kind: 'permission', permission })
    })
  }

  /**
   * @param sessionId - session id.
   * @returns whether a turn is running in the session.
   */
  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  /**
   * Resolve a pending permission or question.
   * @param sessionId - session id.
   * @param requestId - request id from the permission event.
   * @param decision - the user's decision.
   * @returns false when nothing was pending under that id.
   */
  answer(sessionId: string, requestId: string, decision: Decision): boolean {
    const finish = this.runs.get(sessionId)?.pending.get(requestId)
    if (finish === undefined) return false
    finish(decision)
    return true
  }

  /**
   * Interrupt the running turn.
   * @param sessionId - session id.
   * @returns false when no turn is running.
   */
  async interrupt(sessionId: string): Promise<boolean> {
    const run = this.runs.get(sessionId)
    if (run === undefined) return false
    run.interrupted = true
    for (const finish of [...run.pending.values()]) finish({ behavior: 'deny' })
    await run.query.interrupt()
    return true
  }

  /**
   * Subscribe to one session's live events; replays the running turn's events first.
   * @param sessionId - session id.
   * @param subscriber - event callback.
   * @returns the unsubscribe function.
   */
  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    return this.hub.subscribe(sessionId, subscriber)
  }

  /** Interrupt every running turn (plugin teardown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map(id => this.interrupt(id)))
  }
}
