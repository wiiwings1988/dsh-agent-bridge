/**
 * Codex sessions through `codex app-server` (JSON-RPC over stdio, one shared child process). Mirrors the
 * Claude driver: list, transcript, goal, live turns with approvals, interrupt, and session management.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { modelLabel } from './defaults.ts'
import { LineSplitter } from './lines.ts'
import { LiveHub, type Subscriber } from './live.ts'
import {
  CODEX_ID_PREFIX, type BlockWire, type GoalWire, type InfoWire, type MessageWire, type ModelWire, type PermissionWire, type QuestionWire, type SessionRowWire,
} from './protocol.ts'

/** Options of one Codex turn. */
export interface CodexTurnOptions {
  readonly threadId?: string
  readonly cwd: string
  readonly text: string
  readonly approvalPolicy: 'untrusted' | 'on-request'
  readonly sandbox: 'read-only' | 'workspace-write'
  /** Model and reasoning effort for this turn; undefined keeps the thread's. */
  readonly model?: string
  readonly effort?: string
  /** Absolute paths of images sent with the message. */
  readonly images?: readonly string[]
}

/** The user's answer to a pending approval or question. */
export type CodexDecision =
  | { readonly behavior: 'allow'; readonly answers?: Readonly<Record<string, string>>; readonly remember?: boolean }
  | { readonly behavior: 'deny' }

interface RpcMessage {
  readonly id?: number | string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
  readonly error?: { readonly message?: string }
}

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- app-server payloads are read field by field at the wire boundary

class CodexRpc {
  private child: ChildProcess | undefined
  private ready: Promise<void> | undefined
  private readonly lines = new LineSplitter()
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>()

  constructor(
    private readonly executable: string,
    private readonly onMessage: (message: RpcMessage) => void,
  ) {}

  private send(payload: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
  }

  private raw(method: string, params: Record<string, unknown>): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  private ensure(): Promise<void> {
    if (this.ready !== undefined) return this.ready
    const name = userInfo().username
    const child = spawn(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, USER: process.env['USER'] ?? name, LOGNAME: process.env['LOGNAME'] ?? name },
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of this.lines.push(chunk)) {
        if (line.trim() !== '') this.dispatch(JSON.parse(line) as RpcMessage)
      }
    })
    child.on('exit', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('codex app-server exited'))
      this.pending.clear()
      this.child = undefined
      this.ready = undefined
      this.lines.reset()
    })
    this.ready = this.raw('initialize', {
      clientInfo: { name: 'dsh-agent-bridge', title: 'dsh agent bridge', version: '0.1' },
      capabilities: { experimentalApi: true },
    }).then(() => { this.send({ method: 'initialized' }) })
    return this.ready
  }

  private dispatch(message: RpcMessage): void {
    if (message.method === undefined && typeof message.id === 'number') {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter?.reject(new Error(message.error.message ?? 'codex error'))
      else waiter?.resolve((message.result ?? {}) as Json)
    } else {
      this.onMessage(message)
    }
  }

  /**
   * Call a JSON-RPC method, starting the app-server on first use.
   * @param method - method name.
   * @param params - parameters.
   * @returns the result object.
   */
  async call(method: string, params: Record<string, unknown>): Promise<Json> {
    await this.ensure()
    return await this.raw(method, params)
  }

  /**
   * Answer a server request.
   * @param id - request id.
   * @param result - result payload.
   */
  respond(id: number | string, result: unknown): void {
    this.send({ id, result })
  }

  /**
   * Reject a server request.
   * @param id - request id.
   * @param message - error text.
   */
  respondError(id: number | string, message: string): void {
    this.send({ id, error: { code: -32601, message } })
  }

  /** Stop the child process. */
  close(): void {
    this.child?.kill()
  }
}

interface Run {
  turnId?: string
  readonly pending: Map<string, (decision: CodexDecision) => void>
  interrupted: boolean
  error?: string
}

function seconds(value: unknown): number {
  const number = Number(value)
  return number < 1e12 ? number * 1000 : number
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part: Json) => part['type'] === 'text' ? String(part['text'] ?? '') : `[${String(part['type'])}]`).join('\n')
}

/** Tool output longer than this is cut, so one noisy command cannot make a session too large to send. */
const TOOL_OUTPUT_LIMIT = 20_000

const capped = (text: string): string => text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text

function toMessages(item: Json): MessageWire[] {
  const id = String(item['id'])
  switch (item['type']) {
    case 'userMessage':
      return [{ id, role: 'user', blocks: [{ type: 'text', text: textOfContent(item['content']) }] }]
    case 'agentMessage':
      return [{ id, role: 'assistant', blocks: [{ type: 'text', text: String(item['text'] ?? '') }] }]
    case 'plan':
      return [{ id, role: 'assistant', blocks: [{ type: 'text', text: String(item['text'] ?? '') }] }]
    case 'reasoning': {
      const text = [...(item['summary'] as unknown[] ?? []), ...(item['content'] as unknown[] ?? [])].map(String).join('\n')
      return text === '' ? [] : [{ id, role: 'assistant', blocks: [{ type: 'thinking', text }] }]
    }
    case 'commandExecution':
      return [
        { id: `${id}:use`, role: 'assistant', blocks: [{
          type: 'tool_use', name: 'command', input: String(item['command'] ?? ''), id,
          args: { command: String(item['command'] ?? ''), ...typeof item['cwd'] === 'string' ? { cwd: item['cwd'] } : {} },
        }] },
        { id: `${id}:result`, role: 'user', blocks: [{
          type: 'tool_result', text: capped(String(item['aggregatedOutput'] ?? '')), forId: id,
          ...typeof item['exitCode'] === 'number' && item['exitCode'] !== 0 ? { isError: true } : {},
        }] },
      ]
    case 'fileChange': {
      const changes = (item['changes'] as Json[] | undefined) ?? []
      const diff = changes.map(change => `${String(change['path'])}\n${String(change['diff'] ?? '')}`).join('\n')
      return [
        { id: `${id}:use`, role: 'assistant', blocks: [{
          type: 'tool_use', name: 'fileChange', input: changes.map(change => String(change['path'])).join(', '), id,
          args: { paths: changes.map(change => String(change['path'])) },
        }] },
        { id: `${id}:result`, role: 'user', blocks: [{ type: 'tool_result', text: capped(diff), forId: id }] },
      ]
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const text = JSON.stringify(item)
      return [{ id, role: 'assistant', blocks: [{ type: 'tool_use', name: String(item['tool'] ?? item['type']), input: text.length > 400 ? `${text.slice(0, 400)}…` : text, id } as BlockWire] }]
    }
    default:
      return []
  }
}

/** Codex sessions: reading, live turns, and management over one app-server process. */
export class CodexEngine {
  private readonly rpc: CodexRpc
  private readonly hub = new LiveHub()
  private readonly runs = new Map<string, Run>()
  private readonly loaded = new Set<string>()
  private readonly items = new Map<string, Json>()

  /**
   * @param executable - path of the `codex` executable.
   */
  constructor(executable: string) {
    this.rpc = new CodexRpc(executable, message => { this.onMessage(message) })
  }

  /**
   * @param limit - maximum number of rows.
   * @returns thread rows, newest first, with Codex-prefixed ids.
   */
  async listRows(limit: number): Promise<SessionRowWire[]> {
    const result = await this.rpc.call('thread/list', { limit, sortKey: 'updated_at' })
    return (result['data'] as Json[]).map(thread => ({
      id: `${CODEX_ID_PREFIX}${String(thread['id'])}`,
      title: String(thread['name'] ?? thread['preview'] ?? thread['id']),
      cwd: String(thread['cwd'] ?? ''),
      updatedAt: seconds(thread['updatedAt']),
    }))
  }

  /** @returns the models Codex offers to this account. */
  async listModels(): Promise<ModelWire[]> {
    const result = await this.rpc.call('model/list', { limit: 100 })
    return (result['data'] as Json[]).filter(model => model['hidden'] !== true).map(model => ({
      value: String(model['model'] ?? model['id']),
      name: String(model['displayName'] ?? model['model']),
      description: String(model['description'] ?? ''),
      efforts: ((model['supportedReasoningEfforts'] as Json[] | undefined) ?? []).map(item => String(item['reasoningEffort'] ?? item)),
      ...model['isDefault'] === true ? { isDefault: true } : {},
    }))
  }

  /**
   * @param models - the listed models, to name the configured one.
   * @returns names of the model and effort Codex's own configuration sets for a new thread.
   */
  async readDefaults(models: readonly ModelWire[]): Promise<NonNullable<InfoWire['defaults']>> {
    const config = (await this.rpc.call('config/read', {}))['config'] as Json | undefined
    const model = typeof config?.['model'] === 'string' ? modelLabel(config['model'], models) : models.find(entry => entry.isDefault === true)?.name
    const effort = config?.['model_reasoning_effort']
    return { ...model === undefined ? {} : { model }, ...typeof effort === 'string' ? { effort } : {} }
  }

  /** @returns the signed-in account, when Codex reports one. */
  async readAccount(): Promise<NonNullable<InfoWire['account']>> {
    const result = await this.rpc.call('account/read', { refreshToken: false })
    const account = result['account'] as Json | null | undefined
    if (account === null || account === undefined) return { loggedIn: false }
    return {
      loggedIn: true,
      ...typeof account['email'] === 'string' ? { email: account['email'] } : {},
      ...typeof account['planType'] === 'string' ? { plan: account['planType'] } : {},
      provider: String(account['type'] ?? 'codex'),
    }
  }

  /**
   * @param term - text to look for in thread titles and content.
   * @param limit - maximum number of threads.
   * @returns matching thread rows.
   */
  async search(term: string, limit: number): Promise<SessionRowWire[]> {
    const result = await this.rpc.call('thread/list', { limit, sortKey: 'updated_at', searchTerm: term })
    return (result['data'] as Json[]).map(thread => ({
      id: `${CODEX_ID_PREFIX}${String(thread['id'])}`,
      title: String(thread['name'] ?? thread['preview'] ?? thread['id']),
      cwd: String(thread['cwd'] ?? ''),
      updatedAt: seconds(thread['updatedAt']),
    }))
  }

  /**
   * Read the most recent turns. A whole thread can hold hundreds of megabytes of tool output, which the
   * app-server would send back as a single line, so only one page of turns is requested.
   * @param threadId - thread id (no prefix).
   * @param turnLimit - most turns to read, newest first.
   * @returns the transcript messages in order, and whether older turns were left out.
   */
  async readMessages(threadId: string, turnLimit: number): Promise<{ messages: MessageWire[]; earlierOmitted: boolean }> {
    const result = await this.rpc.call('thread/turns/list', { threadId, limit: turnLimit, sortDirection: 'desc', itemsView: 'full' })
    const turns = [...(result['data'] as Json[] | undefined) ?? []].reverse()
    const nextCursor = result['nextCursor'] as string | null | undefined
    return { messages: turns.flatMap(turn => (turn['items'] as Json[]).flatMap(toMessages)), earlierOmitted: nextCursor !== null && nextCursor !== undefined }
  }

  /**
   * @param threadId - thread id (no prefix).
   * @returns the goal unless none exists or it is complete.
   */
  async readGoal(threadId: string): Promise<GoalWire | undefined> {
    const result = await this.rpc.call('thread/goal/get', { threadId })
    const goal = result['goal'] as Json | null | undefined
    if (goal === null || goal === undefined || goal['status'] === 'complete') return undefined
    return { condition: String(goal['objective']), tokensUsed: Number(goal['tokensUsed'] ?? 0), reason: String(goal['status']) }
  }

  /**
   * @param threadId - thread id (no prefix).
   * @returns the rollout file path, or undefined when unknown.
   */
  async findFile(threadId: string): Promise<string | undefined> {
    const result = await this.rpc.call('thread/read', { threadId, includeTurns: false })
    const path = result['thread']['path'] as string | null | undefined
    return path ?? undefined
  }

  /**
   * Start a turn (creating or resuming the thread) or apply a `/goal` command.
   * @param options - turn options.
   * @returns the thread id.
   */
  async start(options: CodexTurnOptions): Promise<string> {
    if (options.threadId !== undefined && this.runs.has(options.threadId)) throw new Error('a turn is already running in this session')
    const settings = { approvalPolicy: options.approvalPolicy, sandbox: options.sandbox }
    let threadId = options.threadId
    if (threadId === undefined) {
      threadId = String((await this.rpc.call('thread/start', { cwd: options.cwd, ...settings }))['thread']['id'])
      this.loaded.add(threadId)
    } else if (!this.loaded.has(threadId)) {
      await this.rpc.call('thread/resume', { threadId, ...settings })
      this.loaded.add(threadId)
    }
    const goal = /^\/goal\s+([\s\S]+)$/.exec(options.text.trim())
    if (goal !== null) {
      const condition = (goal[1] ?? '').trim()
      if (/^(clear|stop|off|reset|none|cancel)$/i.test(condition)) {
        await this.rpc.call('thread/goal/clear', { threadId })
        this.finishWithoutTurn(threadId)
      } else {
        await this.rpc.call('thread/goal/set', { threadId, objective: condition })
        await this.waitForTurnOrGiveUp(threadId)
      }
      return threadId
    }
    const response = await this.rpc.call('turn/start', {
      threadId,
      input: [
        ...(options.images ?? []).map(path => ({ type: 'localImage', path })),
        { type: 'text', text: options.text, text_elements: [] },
      ],
      ...settings,
      ...options.model === undefined || options.model === '' ? {} : { model: options.model },
      ...options.effort === undefined || options.effort === '' ? {} : { effort: options.effort },
    })
    this.ensureRun(threadId).turnId = String(response['turn']['id'])
    return threadId
  }

  private finishWithoutTurn(threadId: string): void {
    this.hub.begin(threadId)
    this.hub.emit(threadId, { kind: 'ended', status: 'ok' })
    this.hub.end(threadId)
  }

  private async waitForTurnOrGiveUp(threadId: string): Promise<void> {
    for (let waited = 0; waited < 8000; waited += 200) {
      if (this.runs.has(threadId)) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    this.finishWithoutTurn(threadId)
  }

  private ensureRun(threadId: string): Run {
    let run = this.runs.get(threadId)
    if (run === undefined) {
      run = { pending: new Map(), interrupted: false }
      this.runs.set(threadId, run)
      this.hub.begin(threadId)
    }
    return run
  }

  private onMessage(message: RpcMessage): void {
    const params = (message.params ?? {}) as Json
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : undefined
    if (message.id !== undefined) {
      this.onRequest(message.id, message.method ?? '', params)
      return
    }
    if (threadId === undefined) return
    switch (message.method) {
      case 'turn/started':
        this.ensureRun(threadId).turnId = String(params['turn']['id'])
        break
      case 'item/started':
        this.items.set(String(params['item']['id']), params['item'])
        break
      case 'item/agentMessage/delta':
        this.ensureRun(threadId)
        this.hub.emit(threadId, { kind: 'delta', text: String(params['delta'] ?? '') })
        break
      case 'item/completed':
        this.ensureRun(threadId)
        this.hub.emit(threadId, { kind: 'message' })
        break
      case 'error':
        this.ensureRun(threadId).error = String(params['error']?.['message'] ?? 'error')
        break
      case 'turn/completed': {
        const run = this.ensureRun(threadId)
        const turn = params['turn'] as Json
        const status = run.interrupted || turn['status'] === 'interrupted' ? 'interrupted' : turn['status'] === 'failed' ? 'error' : 'ok'
        const error = status === 'error' ? String(turn['error']?.['message'] ?? run.error ?? 'turn failed') : undefined
        for (const finish of [...run.pending.values()]) finish({ behavior: 'deny' })
        this.hub.emit(threadId, error === undefined ? { kind: 'ended', status } : { kind: 'ended', status, error })
        this.runs.delete(threadId)
        this.hub.end(threadId)
        this.release(threadId)
        break
      }
      default:
        break
    }
  }

  /** Unload a finished thread so another Codex client can write to it; the next turn resumes it. */
  private release(threadId: string): void {
    this.loaded.delete(threadId)
    this.rpc.call('thread/unsubscribe', { threadId }).catch(() => {
      // The app-server already dropped the thread (for example it exited); nothing else holds it.
    })
  }

  private onRequest(id: number | string, method: string, params: Json): void {
    const threadId = String(params['threadId'] ?? '')
    const run = this.ensureRun(threadId)
    const requestId = randomUUID()
    let permission: PermissionWire
    let reply: (decision: CodexDecision) => unknown
    if (method === 'item/commandExecution/requestApproval') {
      permission = { requestId, tool: 'command', title: String(params['reason'] ?? 'Run command'), input: String(params['command'] ?? '') }
      reply = decision => ({ decision: decision.behavior === 'deny' ? 'decline' : decision.remember === true ? 'acceptForSession' : 'accept' })
    } else if (method === 'item/fileChange/requestApproval') {
      const changes = (this.items.get(String(params['itemId']))?.['changes'] as Json[] | undefined) ?? []
      const input = changes.map(change => `${String(change['path'])}\n${String(change['diff'] ?? '')}`).join('\n') || String(params['reason'] ?? '')
      permission = { requestId, tool: 'fileChange', title: String(params['reason'] ?? 'Apply file changes'), input: input.length > 2000 ? `${input.slice(0, 2000)}…` : input }
      reply = decision => ({ decision: decision.behavior === 'deny' ? 'decline' : decision.remember === true ? 'acceptForSession' : 'accept' })
    } else if (method === 'item/tool/requestUserInput') {
      const raw = (params['questions'] as Json[] | undefined) ?? []
      const questions: QuestionWire[] = raw.map(item => ({
        question: String(item['question']), header: String(item['header'] ?? ''), multiSelect: false,
        options: ((item['options'] as Json[] | null | undefined) ?? []).map(option => ({ label: String(option['label']), description: String(option['description'] ?? '') })),
      }))
      permission = { requestId, tool: 'requestUserInput', title: 'Question', input: '', questions }
      reply = (decision) => {
        const answers: Record<string, { answers: string[] }> = {}
        if (decision.behavior === 'allow') {
          for (const item of raw) {
            const value = decision.answers?.[String(item['question'])]
            if (value !== undefined) answers[String(item['id'])] = { answers: [value] }
          }
        }
        return { answers }
      }
    } else {
      this.rpc.respondError(id, `unsupported request ${method}`)
      return
    }
    run.pending.set(requestId, (decision) => {
      if (!run.pending.delete(requestId)) return
      this.hub.emit(threadId, { kind: 'permission_done', requestId })
      this.rpc.respond(id, reply(decision))
    })
    this.hub.emit(threadId, { kind: 'permission', permission })
  }

  /**
   * @param threadId - thread id (no prefix).
   * @returns whether a turn is running.
   */
  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  /**
   * Resolve a pending approval or question.
   * @param threadId - thread id (no prefix).
   * @param requestId - request id from the permission event.
   * @param decision - the user's decision.
   * @returns false when nothing was pending under that id.
   */
  answer(threadId: string, requestId: string, decision: CodexDecision): boolean {
    const finish = this.runs.get(threadId)?.pending.get(requestId)
    if (finish === undefined) return false
    finish(decision)
    return true
  }

  /**
   * @param threadId - thread id (no prefix).
   * @returns false when no turn is running.
   */
  async interrupt(threadId: string): Promise<boolean> {
    const run = this.runs.get(threadId)
    if (run?.turnId === undefined) return false
    run.interrupted = true
    for (const finish of [...run.pending.values()]) finish({ behavior: 'deny' })
    await this.rpc.call('turn/interrupt', { threadId, turnId: run.turnId })
    return true
  }

  /**
   * @param threadId - thread id (no prefix).
   * @param subscriber - event callback.
   * @returns the unsubscribe function.
   */
  subscribe(threadId: string, subscriber: Subscriber): () => void {
    return this.hub.subscribe(threadId, subscriber)
  }

  /**
   * @param threadId - source thread id (no prefix).
   * @returns the new thread id.
   */
  async fork(threadId: string): Promise<string> {
    const result = await this.rpc.call('thread/fork', { threadId })
    return String(result['thread']['id'])
  }

  /**
   * @param threadId - thread id (no prefix).
   * @param name - new name.
   */
  async rename(threadId: string, name: string): Promise<void> {
    await this.rpc.call('thread/name/set', { threadId, name })
  }

  /**
   * @param threadId - thread id (no prefix).
   */
  async delete(threadId: string): Promise<void> {
    await this.rpc.call('thread/delete', { threadId })
  }

  /** Interrupt running turns and stop the app-server (plugin teardown). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map(id => this.interrupt(id)))
    this.rpc.close()
  }
}
