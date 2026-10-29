/**
 * dsh-agent-bridge, Host half. Serves Claude Code and Codex sessions to the browser half over the
 * authenticated Connection Fetch channel: the session list, transcripts, live turns, session management,
 * and a change feed for the transcript file.
 * @module dsh-agent-bridge
 */
import { statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  deleteClaudeSession, findClaudeFile, forkClaudeSession, listClaudeRows, readClaudeGoal, readClaudeMessages, readClaudeUsage, renameClaudeSession, searchClaude,
} from './claude.ts'
import { CodexEngine } from './codex.ts'
import { probeInfo, probeTools, RunManager, SCREEN_SERVER, type TurnOptions } from './run.ts'
import { readTasks, tasksAction } from './taskmaster.ts'
import { voiceAction } from './voice.ts'
import { watchStream } from './watch.ts'
import { resolveCommand } from './commands.ts'
import { changeSkill, defaultStatePath, listSkills, mcpChange, prepareAttachments, readGitConfig, Scheduler, StateStore, writeGitConfig } from './extras.ts'
import {
  browseDirs, fsAction, gitClone, gitWorktreeAction, gitWorktrees, readImage,
  gitAction, gitBranches, gitCompare, gitDiff, gitDraftMessage, gitLog, gitRemote, gitShow, gitStatus, HttpError, listDir, readText, TerminalManager, writeText,
} from './workbench.ts'
import {
  ANSWER_PATH, ARCHIVE_PATH, PIN_PATH, CHOICE_PATH, DRAFT_PATH, GIT_CONFIG_PATH, INFO_PATH, MCP_PATH, SEARCH_PATH, SKILLS_PATH,
  type ChoiceWire, type InfoWire, type McpBodyWire, type SkillBodyWire,
  FS_LIST_PATH, FS_READ_PATH, FS_WRITE_PATH, GIT_ACTION_PATH, GIT_BRANCHES_PATH, GIT_DIFF_PATH, GIT_LOG_PATH, GIT_STATUS_PATH,
  FS_ACTION_PATH, FS_BROWSE_PATH, FS_IMAGE_PATH, type FsActionWire,
  TASKS_PATH, VOICE_PATH, type TasksBodyWire, type VoiceBodyWire,
  CLONE_PATH, GIT_WORKTREES_PATH, SCHEDULE_PATH, type ScheduleBodyWire, type WorktreeBodyWire,
  GIT_COMPARE_PATH, GIT_MESSAGE_PATH, GIT_REMOTE_PATH, GIT_SHOW_PATH,
  TERM_CLOSE_PATH, TERM_INPUT_PATH, TERM_OPEN_PATH, TERM_RESIZE_PATH, TERM_STREAM_PATH, type GitActionWire, type TermEventWire,
  CLAUDE_ID_PREFIX, CODEX_ID_PREFIX, INTERRUPT_PATH, LIVE_PATH, MANAGE_PATH, SCREEN_STATUS_PATH, SEND_PATH, SESSIONS_PATH, SESSION_PATH, WATCH_PATH,
  type AnswerBodyWire, type GoalWire, type LiveEventWire, type ManageBodyWire, type MessageWire, type SessionRowWire, type SendBodyWire, type SessionWire,
} from './protocol.ts'

/** Stable plugin name (matches the `cordis.patch.yml` row id). */
export const name = 'agent-bridge'

/** Plugin settings; every field is also editable from the plugin's configuration page. */
export interface Settings {
  /** Master switch; false makes every route answer 404. */
  enabled: boolean
  /** Maximum number of Claude Code sessions listed, newest first. */
  sessionLimit: number
  /** Polling interval of the transcript-file watcher, in milliseconds. */
  watchIntervalMs: number
  /** Executable the SDK starts for each turn (the proxy wrapper); empty uses the SDK's bundled binary. */
  claudeExecutable: string
  /** Working directory offered for new sessions; empty uses the home directory. */
  defaultCwd: string
  /** Permission mode of turns started from dsh. */
  permissionMode: 'default' | 'acceptEdits' | 'plan'
  /** dsh memory file appended to the system prompt of new sessions; empty disables the bridge. */
  memoryFile: string
  /** Add the Peekaboo screen-control MCP server to every turn. */
  computerUse: boolean
  /** Add the Playwright browser MCP server to every turn. */
  browserUse: boolean
  /** Speech backend (OpenAI-compatible); empty disables voice. */
  voiceBaseUrl: string
  /** Environment variable holding the backend key. */
  voiceApiKeyEnv: string
  voiceSttModel: string
  voiceTtsModel: string
  voiceTtsVoice: string
  /** Command that runs `task-master-ai` (`npx` fetches the pinned version). */
  taskmasterCommand: string
  /** Show the browser window instead of running it headless. */
  browserHeaded: boolean
  /** Peekaboo executable. */
  peekabooCommand: string
  /** Show Codex sessions and allow starting them. */
  codexEnabled: boolean
  /** `codex` executable that provides `app-server`. */
  codexExecutable: string
  /** Most recent Codex turns read when a session opens; older turns are left out. */
  codexHistoryTurns: number
  /** Approval policy of Codex turns started from dsh. */
  codexApprovalPolicy: 'untrusted' | 'on-request'
  /** Sandbox of Codex turns started from dsh. */
  codexSandbox: 'read-only' | 'workspace-write'
  /** Tools approved without asking (Claude Code permission-rule syntax, e.g. `Bash(git status)`). */
  allowedTools: string[]
}

/**
 * The whole entry config is one volatile reference: a settings edit is committed into the running plugin
 * instead of remounting it, so turns in progress survive it.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  sessionLimit: Schema.natural().min(1).default(100),
  watchIntervalMs: Schema.natural().min(50).default(500),
  claudeExecutable: Schema.string().default('claude'),
  defaultCwd: Schema.string().default(''),
  permissionMode: Schema.union(['default', 'acceptEdits', 'plan'] as const).default('default'),
  memoryFile: Schema.string().default(''),
  computerUse: Schema.boolean().default(true),
  browserUse: Schema.boolean().default(true),
  taskmasterCommand: Schema.string().default('npx'),
  voiceBaseUrl: Schema.string().default(''),
  voiceApiKeyEnv: Schema.string().default('VOICE_API_KEY'),
  voiceSttModel: Schema.string().default('whisper-1'),
  voiceTtsModel: Schema.string().default('tts-1'),
  voiceTtsVoice: Schema.string().default('alloy'),
  browserHeaded: Schema.boolean().default(false),
  peekabooCommand: Schema.string().default('peekaboo'),
  codexEnabled: Schema.boolean().default(true),
  codexExecutable: Schema.string().default('codex'),
  codexHistoryTurns: Schema.natural().min(1).default(20),
  codexApprovalPolicy: Schema.union(['untrusted', 'on-request'] as const).default('untrusted'),
  codexSandbox: Schema.union(['read-only', 'workspace-write'] as const).default('workspace-write'),
  allowedTools: Schema.array(Schema.string()).default([]),
}).volatile()

/** The config the host passes to `apply`. */
export type Config = Volatile<Settings>

/** Services this plugin requires. */
export const inject = ['connection']

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** An external session id split into its engine and the engine's own id. */
interface EngineId {
  readonly engine: 'claude' | 'codex'
  readonly raw: string
}

function parseId(id: string): EngineId | undefined {
  if (id.startsWith(CLAUDE_ID_PREFIX)) return { engine: 'claude', raw: id.slice(CLAUDE_ID_PREFIX.length) }
  if (id.startsWith(CODEX_ID_PREFIX)) return { engine: 'codex', raw: id.slice(CODEX_ID_PREFIX.length) }
  return undefined
}

function idOf(request: Request): EngineId | undefined {
  return parseId(new URL(request.url, 'http://host').searchParams.get('id') ?? '')
}

function prefixed(engine: 'claude' | 'codex', raw: string): string {
  return `${engine === 'claude' ? CLAUDE_ID_PREFIX : CODEX_ID_PREFIX}${raw}`
}

/** What the routes need from an engine; Claude and Codex each provide one. */
interface Driver {
  readMessages(id: string): Promise<{ messages: MessageWire[]; recentTurns?: number }>
  readGoal(id: string): Promise<GoalWire | undefined>
  findFile(id: string): Promise<string | undefined>
  subscribe(id: string, subscriber: (event: LiveEventWire) => void): () => void
  isRunning(id: string): boolean
  interrupt(id: string): Promise<boolean>
  answer(id: string, requestId: string, body: AnswerBodyWire): boolean
  fork(id: string): Promise<string>
  rename(id: string, title: string): Promise<void>
  delete(id: string): Promise<void>
}

async function watchResponse(request: Request, intervalMs: number, driverOf: (engine: 'claude' | 'codex') => Driver): Promise<Response> {
  const parsed = idOf(request)
  const file = parsed === undefined ? undefined : await driverOf(parsed.engine).findFile(parsed.raw)
  if (file === undefined) return json({ error: 'unknown session' }, 404)
  return watchStream(file, intervalMs, request.signal)
}

function homedirOf(settings: Settings): string {
  return settings.defaultCwd === '' ? homedir() : settings.defaultCwd
}

function turnOptions(settings: Settings, sessionId: string | undefined, text: string, cwd: string, memory = '', extra: Pick<TurnOptions, 'model' | 'effort' | 'images'> = {}): TurnOptions {
  return {
    ...extra,
    ...sessionId === undefined ? {} : { sessionId },
    cwd, text,
    executable: settings.claudeExecutable,
    permissionMode: settings.permissionMode,
    allowedTools: settings.allowedTools,
    computerUse: settings.computerUse,
    browserUse: settings.browserUse,
    browserHeaded: settings.browserHeaded,
    peekabooCommand: settings.peekabooCommand,
    memory,
  }
}

function liveResponse(request: Request, driverOf: (engine: 'claude' | 'codex') => Driver): Response {
  const parsed = idOf(request)
  if (parsed === undefined) return json({ error: 'unknown session' }, 404)
  const encoder = new TextEncoder()
  let release: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: LiveEventWire): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      release = driverOf(parsed.engine).subscribe(parsed.raw, send)
      request.signal.addEventListener('abort', () => release?.(), { once: true })
    },
    cancel: () => release?.(),
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Register the routes.
 * @param ctx - plugin context.
 * @param config - configuration from the composition entry.
 */
export function apply(ctx: Context, config: Config): void {
  const current = (): Settings => {
    const settings = config.get() as Settings
    return {
      ...settings,
      claudeExecutable: resolveCommand(settings.claudeExecutable),
      codexExecutable: resolveCommand(settings.codexExecutable),
      peekabooCommand: resolveCommand(settings.peekabooCommand),
    }
  }
  const connection = ctx.connection
  const runs = new RunManager()
  let codexEngine: CodexEngine | undefined
  const codex = (): CodexEngine => {
    codexEngine ??= new CodexEngine(current().codexExecutable)
    return codexEngine
  }
  const store = new StateStore(process.env['AGENT_BRIDGE_STATE'] ?? defaultStatePath(), defaultStatePath('external-engines'))
  const terminals = new TerminalManager()
  ctx.effect(() => () => {
    terminals.closeAll()
    void runs.closeAll()
    void codexEngine?.closeAll()
  }, 'agent-bridge: runs')
  const claudeDriver: Driver = {
    readMessages: async id => ({ messages: await readClaudeMessages(id) }),
    readGoal: readClaudeGoal,
    findFile: findClaudeFile,
    subscribe: (id, subscriber) => runs.subscribe(id, subscriber),
    isRunning: id => runs.isRunning(id),
    interrupt: id => runs.interrupt(id),
    answer: (id, requestId, body) => runs.answer(id, requestId, body.behavior === 'allow'
      ? { behavior: 'allow', ...body.answers === undefined ? {} : { answers: body.answers } }
      : { behavior: 'deny' }),
    fork: forkClaudeSession,
    rename: renameClaudeSession,
    delete: deleteClaudeSession,
  }
  const codexDriver: Driver = {
    readMessages: async (id) => {
      const turns = current().codexHistoryTurns
      const page = await codex().readMessages(id, turns)
      return { messages: page.messages, ...page.earlierOmitted ? { recentTurns: turns } : {} }
    },
    readGoal: id => codex().readGoal(id),
    findFile: id => codex().findFile(id),
    subscribe: (id, subscriber) => codex().subscribe(id, subscriber),
    isRunning: id => codex().isRunning(id),
    interrupt: id => codex().interrupt(id),
    answer: (id, requestId, body) => codex().answer(id, requestId, body.behavior === 'allow'
      ? { behavior: 'allow', ...body.answers === undefined ? {} : { answers: body.answers }, ...body.remember === true ? { remember: true } : {} }
      : { behavior: 'deny' }),
    fork: id => codex().fork(id),
    rename: (id, title) => codex().rename(id, title),
    delete: id => codex().delete(id),
  }
  const driverOf = (engine: 'claude' | 'codex'): Driver => engine === 'claude' ? claudeDriver : codexDriver
  const route = (
    path: string, handler: (request: Request, config: Settings) => Promise<Response> | Response, label: string, method: 'GET' | 'POST' | 'BOTH' = 'GET',
  ): void => {
    ctx.effect(() => connection.fetch.register({
      path,
      methods: method === 'BOTH' ? ['GET', 'POST'] : [method],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (!current().enabled) return json({ error: 'disabled' }, 404)
        try {
          return await handler(request, current())
        } catch (error) {
          if (error instanceof HttpError) return json({ error: error.message }, error.status)
          return json({ error: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), `agent-bridge: ${label} route`)
  }
  route(SESSIONS_PATH, async (request, settings) => {
    const warnings: string[] = []
    let codexRows: SessionRowWire[] = []
    if (settings.codexEnabled) {
      try {
        codexRows = await codex().listRows(settings.sessionLimit)
      } catch (error) {
        warnings.push(`codex: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const archived = new Set(store.get('archived'))
    const wantArchived = query(request, 'archived') === '1'
    const all = [...await listClaudeRows(settings.sessionLimit), ...codexRows]
    const rows = all.filter(row => archived.has(row.id) === wantArchived).sort((a, b) => b.updatedAt - a.updatedAt)
    const running = rows.filter((row) => {
      const parsed = parseId(row.id)
      return parsed !== undefined && driverOf(parsed.engine).isRunning(parsed.raw)
    }).map(row => row.id)
    return json({ sessions: rows, running, pinned: store.get('pinned'), defaultCwd: homedirOf(settings), codexEnabled: settings.codexEnabled, warnings })
  }, 'sessions')
  route(SESSION_PATH, async (request) => {
    const parsed = idOf(request)
    if (parsed === undefined) return json({ error: 'unknown session' }, 404)
    const driver = driverOf(parsed.engine)
    const goal = await driver.readGoal(parsed.raw)
    const usage = parsed.engine === 'claude' ? await readClaudeUsage(parsed.raw) : undefined
    const page = await driver.readMessages(parsed.raw)
    const body: SessionWire = { messages: page.messages, ...page.recentTurns === undefined ? {} : { recentTurns: page.recentTurns }, ...goal === undefined ? {} : { goal }, ...usage === undefined ? {} : { usage } }
    return json(body)
  }, 'session')
  route(WATCH_PATH, (request, settings) => watchResponse(request, settings.watchIntervalMs, driverOf), 'watch')
  route(LIVE_PATH, request => liveResponse(request, driverOf), 'live')
  const sendMessage = async (body: SendBodyWire, settings: Settings): Promise<{ id: string }> => {
    const parsed = body.id === undefined ? undefined : parseId(body.id)
    const engine = parsed?.engine ?? body.engine ?? 'claude'
    // A resumed session runs in its own folder; the browser sends it, and a caller that does not is looked up.
    const knownCwd = body.cwd ?? (parsed?.engine === 'claude' ? (await listClaudeRows(Math.max(settings.sessionLimit, 1000))).find(row => row.id === body.id)?.cwd : undefined)
    const cwd = knownCwd === undefined || knownCwd === '' ? homedirOf(settings) : knownCwd
    // The engines report a missing folder as a missing executable; say what is actually wrong.
    if (statSync(cwd, { throwIfNoEntry: false })?.isDirectory() !== true) throw new HttpError(400, `the working directory no longer exists: ${cwd}`)
    const attached = await prepareAttachments(body.attachments)
    const text = `${body.text}${attached.note}`
    const clearDraft = (): void => { store.set('drafts', Object.fromEntries(Object.entries(store.get('drafts')).filter(([key]) => key !== (body.id ?? '')))) }
    if (engine === 'codex') {
      if (!settings.codexEnabled) throw new HttpError(404, 'codex is disabled')
      const id = await codex().start({
        ...parsed === undefined ? {} : { threadId: parsed.raw },
        cwd, text, approvalPolicy: settings.codexApprovalPolicy, sandbox: settings.codexSandbox,
        ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort },
        images: attached.imagePaths,
      })
      clearDraft()
      return { id: prefixed('codex', id) }
    }
    const memory = settings.memoryFile === '' ? '' : await readFile(settings.memoryFile, 'utf8')
    const id = await runs.start(turnOptions(settings, parsed?.raw, text, cwd, memory, {
      ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort }, images: attached.images,
    }))
    clearDraft()
    return { id: prefixed('claude', id) }
  }
  route(SEND_PATH, async (request, settings) => json(await sendMessage(await request.json() as SendBodyWire, settings)), 'send', 'POST')
  const scheduler = new Scheduler(
    store,
    async (message) => {
      await sendMessage({ id: message.sessionId, cwd: message.cwd, text: message.text, ...message.model === undefined ? {} : { model: message.model }, ...message.effort === undefined ? {} : { effort: message.effort } }, current())
    },
    (sessionId) => { const parsed = parseId(sessionId); return parsed !== undefined && driverOf(parsed.engine).isRunning(parsed.raw) },
  )
  scheduler.start()
  ctx.effect(() => () => { scheduler.stop() }, 'agent-bridge: scheduler')
  route(SCHEDULE_PATH, async (request) => {
    if (request.method === 'GET') {
      const id = query(request, 'id')
      return json({ messages: scheduler.list(id).map(({ id: messageId, sessionId, text, at, status, error }) => ({ id: messageId, sessionId, text, at, status, ...error === undefined ? {} : { error } })) })
    }
    const body = await request.json() as ScheduleBodyWire
    if (body.action === 'cancel') return json({ ok: scheduler.cancel(body.id) })
    if (parseId(body.sessionId) === undefined) throw new HttpError(404, 'unknown session')
    const created = scheduler.add({ sessionId: body.sessionId, cwd: body.cwd, text: body.text, at: body.at, ...body.model === undefined ? {} : { model: body.model }, ...body.effort === undefined ? {} : { effort: body.effort } })
    return json({ id: created.id })
  }, 'schedule', 'BOTH')
  route(ANSWER_PATH, async (request) => {
    const body = await request.json() as AnswerBodyWire
    const parsed = parseId(body.id)
    const found = parsed !== undefined && driverOf(parsed.engine).answer(parsed.raw, body.requestId, body)
    return json({ ok: found }, found ? 200 : 404)
  }, 'answer', 'POST')
  route(MANAGE_PATH, async (request) => {
    const body = await request.json() as ManageBodyWire
    const parsed = parseId(body.id)
    if (parsed === undefined) return json({ error: 'unknown session' }, 404)
    const driver = driverOf(parsed.engine)
    if (driver.isRunning(parsed.raw)) return json({ error: 'a turn is running in this session' }, 409)
    switch (body.action) {
      case 'fork':
        return json({ id: prefixed(parsed.engine, await driver.fork(parsed.raw)) })
      case 'rename':
        await driver.rename(parsed.raw, body.title ?? '')
        return json({ ok: true })
      case 'delete':
        await driver.delete(parsed.raw)
        return json({ ok: true })
    }
  }, 'manage', 'POST')
  route(SCREEN_STATUS_PATH, async (_request, settings) => {
    const { stdout } = await promisify(execFile)(settings.peekabooCommand, ['permissions', 'status', '--no-remote'], { timeout: 20_000 })
    const lines = stdout.split('\n').map(line => line.trim()).filter(line => /(Granted|Denied|Not)/i.test(line))
    if (!settings.computerUse) return json({ lines, tools: [], server: 'disabled' })
    const probe = await probeTools(turnOptions(settings, undefined, '', homedirOf(settings)))
    const tools = probe.tools.filter(tool => tool.startsWith(`mcp__${SCREEN_SERVER}__`)).map(tool => tool.slice(`mcp__${SCREEN_SERVER}__`.length))
    return json({ lines, tools, server: probe.mcpServers.find(server => server.name === SCREEN_SERVER)?.status ?? 'missing' })
  }, 'screen status')
  route(INTERRUPT_PATH, async (request) => {
    const body = await request.json() as { id: string }
    const parsed = parseId(body.id)
    const found = parsed !== undefined && await driverOf(parsed.engine).interrupt(parsed.raw)
    return json({ ok: found }, found ? 200 : 404)
  }, 'interrupt', 'POST')
  const query = (request: Request, key: string): string => new URL(request.url).searchParams.get(key) ?? ''
  route(TERM_OPEN_PATH, async (request) => {
    const body = await request.json() as { cwd: string; cols?: number; rows?: number }
    return json({ tid: terminals.open(body.cwd, body.cols ?? 80, body.rows ?? 24) })
  }, 'terminal open', 'POST')
  route(TERM_STREAM_PATH, (request) => {
    const tid = query(request, 'tid')
    const encoder = new TextEncoder()
    let release: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        release = terminals.subscribe(tid, (event: TermEventWire) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        })
        request.signal.addEventListener('abort', () => release?.(), { once: true })
      },
      cancel: () => release?.(),
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } })
  }, 'terminal stream')
  route(TERM_INPUT_PATH, async (request) => {
    const body = await request.json() as { tid: string; data: string }
    terminals.input(body.tid, body.data)
    return json({ ok: true })
  }, 'terminal input', 'POST')
  route(TERM_RESIZE_PATH, async (request) => {
    const body = await request.json() as { tid: string; cols: number; rows: number }
    terminals.resize(body.tid, body.cols, body.rows)
    return json({ ok: true })
  }, 'terminal resize', 'POST')
  route(TERM_CLOSE_PATH, async (request) => {
    terminals.close(((await request.json()) as { tid: string }).tid)
    return json({ ok: true })
  }, 'terminal close', 'POST')
  route(FS_LIST_PATH, async request => json({ entries: await listDir(query(request, 'cwd'), query(request, 'path')) }), 'fs list')
  route(FS_READ_PATH, async request => json(await readText(query(request, 'cwd'), query(request, 'path'))), 'fs read')
  route(FS_WRITE_PATH, async (request) => {
    const body = await request.json() as { cwd: string; path: string; content: string; baseMtimeMs?: number }
    return json(await writeText(body.cwd, body.path, body.content, body.baseMtimeMs))
  }, 'fs write', 'POST')
  route(FS_ACTION_PATH, async request => json(await fsAction(await request.json() as FsActionWire)), 'fs action', 'POST')
  route(FS_IMAGE_PATH, async request => json(await readImage(query(request, 'cwd'), query(request, 'path'))), 'fs image')
  route(FS_BROWSE_PATH, async request => json(await browseDirs(query(request, 'path'))), 'fs browse')
  route(GIT_STATUS_PATH, async request => json(await gitStatus(query(request, 'cwd'))), 'git status')
  route(GIT_DIFF_PATH, async request => json({
    diff: await gitDiff(query(request, 'cwd'), query(request, 'path'), query(request, 'staged') === '1', query(request, 'untracked') === '1'),
  }), 'git diff')
  route(GIT_LOG_PATH, async request => json({ commits: await gitLog(query(request, 'cwd')) }), 'git log')
  route(GIT_BRANCHES_PATH, async request => json(await gitBranches(query(request, 'cwd'))), 'git branches')
  route(GIT_REMOTE_PATH, async request => json(await gitRemote(query(request, 'cwd'))), 'git remote')
  route(GIT_SHOW_PATH, async request => json(await gitShow(query(request, 'cwd'), query(request, 'hash'))), 'git show')
  route(GIT_COMPARE_PATH, async request => json(await gitCompare(query(request, 'cwd'), query(request, 'base'), query(request, 'head'))), 'git compare')
  route(GIT_MESSAGE_PATH, async (request, settings) => json({ message: await gitDraftMessage(query(request, 'cwd'), settings.claudeExecutable) }), 'git message')
  route(GIT_ACTION_PATH, async request => json(await gitAction(await request.json() as GitActionWire)), 'git action', 'POST')
  const infoCache = new Map<string, { at: number; info: InfoWire }>()
  const infoLoads = new Map<string, Promise<InfoWire>>()
  route(INFO_PATH, async (request, settings) => {
    const engine = query(request, 'engine') === 'codex' ? 'codex' : 'claude'
    const asked = query(request, 'cwd') || homedirOf(settings)
    // A project folder that was deleted or moved must not break the lists: fall back to the home directory.
    const cwd = statSync(asked, { throwIfNoEntry: false })?.isDirectory() === true ? asked : homedir()
    const key = `${engine}:${cwd}`
    // Only the newest load of a key writes the cache; a forced load or an MCP change supersedes the running one.
    const load = (force: boolean): Promise<InfoWire> => {
      const running = infoLoads.get(key)
      if (running !== undefined && !force) return running
      const started: Promise<InfoWire> = (engine === 'codex'
        ? codex().listModels().then(async models => ({ models, commands: [], mcp: [], account: await codex().readAccount(), defaults: await codex().readDefaults(models) }))
        : probeInfo(turnOptions(settings, undefined, '', cwd)))
        .then((info) => { if (infoLoads.get(key) === started) infoCache.set(key, { at: Date.now(), info }); return info })
        .finally(() => { if (infoLoads.get(key) === started) infoLoads.delete(key) })
      infoLoads.set(key, started)
      return started
    }
    const cached = infoCache.get(key)
    const fresh = query(request, 'fresh') === '1'
    if (cached === undefined || fresh) return json(await load(fresh))
    // Asking the engine takes seconds (Claude starts a process), so an old answer is served while a newer one loads.
    if (Date.now() - cached.at >= 20_000) load(false).catch(() => { /* the old answer stays until a load succeeds */ })
    return json(cached.info)
  }, 'info')
  route(SEARCH_PATH, async (request, settings) => {
    const term = query(request, 'q').trim()
    if (term.length < 2) return json({ hits: [] })
    const archived = new Set(store.get('archived'))
    const claudeRows = (await listClaudeRows(settings.sessionLimit)).filter(row => !archived.has(row.id))
    const hits = await searchClaude(claudeRows, term, 30)
    if (settings.codexEnabled) {
      for (const row of await codex().search(term, 20).catch(() => [])) {
        if (!archived.has(row.id)) hits.push({ id: row.id, title: row.title, snippet: '', cwd: row.cwd })
      }
    }
    return json({ hits })
  }, 'search')
  route(DRAFT_PATH, async (request) => {
    if (request.method === 'GET') return json({ text: store.get('drafts')[query(request, 'id')] ?? '' })
    const body = await request.json() as { id: string; text: string }
    const drafts = { ...store.get('drafts') }
    if (body.text === '') delete drafts[body.id]
    else drafts[body.id] = body.text.slice(0, 100_000)
    store.set('drafts', drafts)
    return json({ ok: true })
  }, 'draft', 'BOTH')
  route(CHOICE_PATH, async (request) => {
    if (request.method === 'GET') return json(store.get('choices')[query(request, 'engine')] ?? { model: '', effort: '' })
    const body = await request.json() as { engine: unknown } & Record<keyof ChoiceWire, unknown>
    if ((body.engine !== 'claude' && body.engine !== 'codex') || typeof body.model !== 'string' || typeof body.effort !== 'string' || body.model.length > 200 || body.effort.length > 50) {
      return json({ error: 'invalid choice' }, 400)
    }
    store.set('choices', { ...store.get('choices'), [body.engine]: { model: body.model, effort: body.effort } })
    return json({ ok: true })
  }, 'choice', 'BOTH')
  route(ARCHIVE_PATH, async (request) => {
    const body = await request.json() as { id: string; archived: boolean }
    if (parseId(body.id) === undefined) return json({ error: 'unknown session' }, 404)
    const set = new Set(store.get('archived'))
    if (body.archived) set.add(body.id)
    else set.delete(body.id)
    store.set('archived', [...set])
    return json({ ok: true })
  }, 'archive', 'POST')
  route(PIN_PATH, async (request) => {
    const body = await request.json() as { id: string; pinned: boolean }
    if (parseId(body.id) === undefined) return json({ error: 'unknown session' }, 404)
    const set = new Set(store.get('pinned'))
    if (body.pinned) set.add(body.id)
    else set.delete(body.id)
    store.set('pinned', [...set])
    return json({ ok: true })
  }, 'pin', 'POST')
  route(SKILLS_PATH, async (request) => {
    if (request.method === 'GET') return json({ skills: await listSkills(query(request, 'cwd')) })
    return json(await changeSkill(await request.json() as SkillBodyWire))
  }, 'skills', 'BOTH')
  route(MCP_PATH, async (request, settings) => {
    const result = await mcpChange(settings.claudeExecutable, await request.json() as McpBodyWire)
    infoCache.clear()
    infoLoads.clear()
    return json(result)
  }, 'mcp change', 'POST')
  route(GIT_CONFIG_PATH, async (request) => {
    if (request.method === 'GET') return json(await readGitConfig())
    const body = await request.json() as { name: string; email: string }
    return json(await writeGitConfig(body.name, body.email))
  }, 'git config', 'BOTH')
  route(GIT_WORKTREES_PATH, async (request) => {
    if (request.method === 'GET') return json({ worktrees: await gitWorktrees(query(request, 'cwd')) })
    return json(await gitWorktreeAction(await request.json() as WorktreeBodyWire))
  }, 'worktrees', 'BOTH')
  route(CLONE_PATH, async (request) => {
    const body = await request.json() as { url: string; parent: string; name: string }
    return json(await gitClone(body.url, body.parent, body.name))
  }, 'clone', 'POST')
  route(TASKS_PATH, async (request, settings) => {
    if (request.method === 'GET') return json(await readTasks(query(request, 'cwd'), query(request, 'tag') || undefined))
    return json(await tasksAction(await request.json() as TasksBodyWire, settings.taskmasterCommand))
  }, 'tasks', 'BOTH')
  route(VOICE_PATH, async (request, settings) => {
    if (request.method === 'GET') return json({ enabled: settings.voiceBaseUrl.trim() !== '' })
    return json(await voiceAction(await request.json() as VoiceBodyWire, {
      baseUrl: settings.voiceBaseUrl, apiKeyEnv: settings.voiceApiKeyEnv, sttModel: settings.voiceSttModel, ttsModel: settings.voiceTtsModel, ttsVoice: settings.voiceTtsVoice,
    }))
  }, 'voice', 'BOTH')
}
