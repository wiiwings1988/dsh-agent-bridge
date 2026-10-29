/**
 * Small host services around the sessions: persisted state (drafts, archive), attachments,
 * MCP servers and skills of the Claude configuration, and the global git identity.
 * @module dsh-agent-bridge/extras
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { claudeConfigDir } from './claude.ts'
import type { AttachmentWire, ChoiceWire, McpBodyWire, SkillBodyWire, SkillWire } from './protocol.ts'
import { HttpError } from './workbench.ts'

const exec = promisify(execFile)

/** Everything this plugin keeps between restarts. */
export interface PersistedState {
  drafts: Record<string, string>
  /** Last model and effort picked per engine, used as the starting choice in every browser. */
  choices: Record<string, ChoiceWire>
  archived: string[]
  /** Sessions pinned in the Workspace browser, as prefixed session ids. */
  pinned: string[]
  scheduled: ScheduledMessage[]
}

/** A message waiting to be sent to a session at a time. */
export interface ScheduledMessage {
  readonly id: string
  readonly sessionId: string
  readonly cwd: string
  readonly text: string
  readonly at: number
  readonly model?: string
  readonly effort?: string
  status: 'pending' | 'sent' | 'failed'
  error?: string
}

/**
 * Where the state file lives: next to the dsh home, never inside a session directory.
 * @param plugin - directory name; `external-engines` is where releases before the rename wrote it.
 * @returns the absolute state file path.
 */
export function defaultStatePath(plugin: 'agent-bridge' | 'external-engines' = 'agent-bridge'): string {
  return join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), plugin, 'state.json')
}

/**
 * JSON file with whole-file atomic replacement. While `path` does not exist the store starts from `legacyPath`
 * (the file of the plugin's previous name); the first `set` then writes everything to `path` and leaves the
 * legacy file unchanged.
 */
export class StateStore {
  private state: PersistedState
  constructor(private readonly path: string, legacyPath?: string) {
    this.state = { drafts: {}, choices: {}, archived: [], pinned: [], scheduled: [] }
    const source = legacyPath !== undefined && !existsSync(path) ? legacyPath : path
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(source, 'utf8')) as Partial<PersistedState> }
    } catch { /* first run, or an unreadable file: start empty */ }
  }

  get<K extends keyof PersistedState>(key: K): PersistedState[K] { return this.state[key] }

  set<K extends keyof PersistedState>(key: K, value: PersistedState[K]): void {
    this.state = { ...this.state, [key]: value }
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

/** The Claude executable and the environment the CLI needs (the login lookup wants USER). */
function cliEnv(): NodeJS.ProcessEnv {
  const name = userInfo().username
  return { ...process.env, USER: process.env['USER'] ?? name, LOGNAME: process.env['LOGNAME'] ?? name }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Run `claude mcp add-json` / `remove`; the CLI owns the configuration files. */
export async function mcpChange(executable: string, body: McpBodyWire): Promise<{ ok: true }> {
  if (!SAFE_NAME.test(body.name)) throw new HttpError(400, 'invalid server name')
  const args = body.action === 'add'
    ? ['mcp', 'add-json', '--scope', body.scope, body.name, JSON.stringify(body.config)]
    : ['mcp', 'remove', '--scope', body.scope, body.name]
  try {
    await exec(executable === '' ? 'claude' : executable, args, { cwd: statSync(body.cwd, { throwIfNoEntry: false })?.isDirectory() === true ? body.cwd : homedir(), env: cliEnv(), timeout: 30_000 })
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string }
    throw new HttpError(400, (failure.stderr ?? failure.stdout ?? failure.message).trim() || failure.message)
  }
  return { ok: true }
}

function skillDir(cwd: string, scope: 'user' | 'project'): string {
  return scope === 'user' ? join(claudeConfigDir(), 'skills') : join(cwd, '.claude', 'skills')
}

/** Skills stored as `<dir>/<name>/SKILL.md` in the user and project scopes. */
export async function listSkills(cwd: string): Promise<SkillWire[]> {
  const result: SkillWire[] = []
  for (const scope of ['user', 'project'] as const) {
    if (scope === 'project' && cwd === '') continue
    const root = skillDir(cwd, scope)
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const text = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined)
      if (text === undefined) continue
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
      result.push({ name: entry.name, scope, description })
    }
  }
  return result
}

/** Create or remove one skill folder. */
export async function changeSkill(body: SkillBodyWire): Promise<{ ok: true }> {
  if (!SAFE_NAME.test(body.name)) throw new HttpError(400, 'invalid skill name')
  if (body.scope === 'project' && body.cwd === '') throw new HttpError(400, 'cwd is required for a project skill')
  const dir = join(skillDir(body.cwd, body.scope), body.name)
  if (body.action === 'remove') {
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  }
  const exists = await readFile(join(dir, 'SKILL.md'), 'utf8').then(() => true, () => false)
  if (exists) throw new HttpError(409, 'a skill with this name already exists')
  await mkdir(dir, { recursive: true })
  const description = body.description.replace(/\r?\n/g, ' ').trim()
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${body.name}\ndescription: ${description}\n---\n\n${body.body}\n`)
  return { ok: true }
}

/** The global git identity (`user.name`, `user.email`). */
export async function readGitConfig(): Promise<{ name: string; email: string }> {
  const read = async (key: string): Promise<string> => (await exec('git', ['config', '--global', '--get', key]).then(result => result.stdout, () => '')).trim()
  return { name: await read('user.name'), email: await read('user.email') }
}

/** Set the global git identity. */
export async function writeGitConfig(name: string, email: string): Promise<{ ok: true }> {
  if (/[\r\n]/.test(name + email)) throw new HttpError(400, 'invalid value')
  if (name !== '') await exec('git', ['config', '--global', 'user.name', name])
  if (email !== '') await exec('git', ['config', '--global', 'user.email', email])
  return { ok: true }
}

const ATTACHMENT_LIMIT = 20_000_000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** Attachments split for the engines: images go in the message, other files are written to a temp folder. */
export interface PreparedAttachments {
  readonly images: readonly { readonly mime: string; readonly base64: string }[]
  /** Absolute paths of every attachment written to disk (images included, for engines that take paths). */
  readonly paths: readonly string[]
  readonly imagePaths: readonly string[]
  /** Text appended to the message so the model can find the non-image files. */
  readonly note: string
}

/** Write attachments to a private temp folder and describe them. */
export async function prepareAttachments(attachments: readonly AttachmentWire[] | undefined): Promise<PreparedAttachments> {
  const list = attachments ?? []
  if (list.length === 0) return { images: [], paths: [], imagePaths: [], note: '' }
  const dir = join(tmpdir(), 'dsh-agent-bridge', randomUUID())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const images: { mime: string; base64: string }[] = []
  const paths: string[] = []
  const imagePaths: string[] = []
  const others: string[] = []
  for (const [index, item] of list.entries()) {
    if (Buffer.byteLength(item.base64, 'base64') > ATTACHMENT_LIMIT) throw new HttpError(413, `${item.name} is too large`)
    const safe = item.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || `file-${index}`
    const path = join(dir, `${index}-${safe}`)
    await writeFile(path, Buffer.from(item.base64, 'base64'), { mode: 0o600 })
    paths.push(path)
    if (IMAGE_TYPES.has(item.mime)) { images.push({ mime: item.mime, base64: item.base64 }); imagePaths.push(path) } else others.push(path)
  }
  return { images, paths, imagePaths, note: others.length === 0 ? '' : `\n\nAttached files:\n${others.map(path => `- ${path}`).join('\n')}` }
}

/** How long a message may wait for a busy session before it is given up on. */
const SCHEDULE_PATIENCE_MS = 10 * 60_000
/** Finished entries are kept this long so the list can show what happened. */
const SCHEDULE_KEEP_MS = 7 * 24 * 3_600_000

/** Sends scheduled messages when they fall due. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  /**
   * @param store - persisted state.
   * @param send - sends one message to its session; rejects when it cannot.
   * @param isRunning - whether a turn is already running in a session (the message then waits).
   * @param now - clock, replaceable in tests.
   */
  constructor(
    private readonly store: StateStore,
    private readonly send: (message: ScheduledMessage) => Promise<void>,
    private readonly isRunning: (sessionId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  list(sessionId: string): ScheduledMessage[] {
    return this.store.get('scheduled').filter(message => message.sessionId === sessionId).sort((a, b) => a.at - b.at)
  }

  add(input: Omit<ScheduledMessage, 'id' | 'status'>): ScheduledMessage {
    if (input.text.trim() === '') throw new HttpError(400, 'the message is empty')
    if (!Number.isFinite(input.at) || input.at < this.now() - 1000) throw new HttpError(400, 'the time is in the past')
    const message: ScheduledMessage = { ...input, id: randomUUID(), status: 'pending' }
    this.store.set('scheduled', [...this.store.get('scheduled'), message])
    return message
  }

  cancel(id: string): boolean {
    const all = this.store.get('scheduled')
    const target = all.find(message => message.id === id)
    if (target === undefined || target.status !== 'pending') return false
    this.store.set('scheduled', all.filter(message => message.id !== id))
    return true
  }

  /** Send everything that is due once; safe to call often. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const message of this.store.get('scheduled').filter(item => item.status === 'pending' && item.at <= now)) {
        if (this.isRunning(message.sessionId)) {
          if (now - message.at > SCHEDULE_PATIENCE_MS) this.finish(message.id, 'failed', 'the session stayed busy')
          continue
        }
        try {
          this.finish(message.id, 'sent')
          await this.send(message)
        } catch (error) {
          this.finish(message.id, 'failed', error instanceof Error ? error.message : String(error))
        }
      }
      const cutoff = now - SCHEDULE_KEEP_MS
      const kept = this.store.get('scheduled').filter(message => message.status === 'pending' || message.at > cutoff)
      if (kept.length !== this.store.get('scheduled').length) this.store.set('scheduled', kept)
    } finally {
      this.ticking = false
    }
  }

  private finish(id: string, status: 'sent' | 'failed', error?: string): void {
    this.store.set('scheduled', this.store.get('scheduled').map(message => message.id === id
      ? { ...message, status, ...error === undefined ? {} : { error } }
      : message))
  }

  start(intervalMs = 5000): void {
    this.stop()
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
