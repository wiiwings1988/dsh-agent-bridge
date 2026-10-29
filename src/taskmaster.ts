/**
 * TaskMaster support: reads and edits the `.taskmaster` folder of a project and runs the `task-master-ai`
 * command for the operations that need a model (adding a task, updating one, parsing a PRD).
 * @module dsh-agent-bridge/taskmaster
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TasksBodyWire, TasksWire, TaskWire } from './protocol.ts'
import { HttpError, resolveIn } from './workbench.ts'

const exec = promisify(execFile)

/** Pinned so a new upstream release cannot change what runs on this machine. The package's own bin is its MCP server; the command line is `task-master`. */
const PACKAGE = 'task-master-ai@0.43.0'
const STATUSES = new Set(['pending', 'in-progress', 'done', 'review', 'deferred', 'cancelled', 'blocked'])
const PRD_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,100}\.(md|txt)$/

type Raw = Record<string, unknown>

const folder = (cwd: string): string => join(cwd, '.taskmaster')
const tasksFile = (cwd: string): string => join(folder(cwd), 'tasks', 'tasks.json')
const docsDir = (cwd: string): string => join(folder(cwd), 'docs')

function toTask(raw: Raw, parent?: string): TaskWire {
  const id = parent === undefined ? String(raw['id']) : `${parent}.${String(raw['id'])}`
  const subtasks = Array.isArray(raw['subtasks']) ? (raw['subtasks'] as Raw[]).map(item => toTask(item, id)) : []
  return {
    id, title: String(raw['title'] ?? ''), description: String(raw['description'] ?? ''), status: String(raw['status'] ?? 'pending'),
    priority: String(raw['priority'] ?? ''), dependencies: Array.isArray(raw['dependencies']) ? (raw['dependencies'] as unknown[]).map(String) : [], subtasks,
  }
}

/** Both layouts of tasks.json: `{ tasks: [] }` and tagged `{ master: { tasks: [] }, ... }`. */
function tagged(data: Raw): Record<string, Raw[]> {
  if (Array.isArray(data['tasks'])) return { master: data['tasks'] as Raw[] }
  const result: Record<string, Raw[]> = {}
  for (const [tag, value] of Object.entries(data)) {
    const tasks = (value as Raw | undefined)?.['tasks']
    if (Array.isArray(tasks)) result[tag] = tasks as Raw[]
  }
  return result
}

async function readData(cwd: string): Promise<Raw | undefined> {
  try { return JSON.parse(await readFile(tasksFile(cwd), 'utf8')) as Raw } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new HttpError(422, 'tasks.json is not valid JSON')
  }
}

/** The tasks of one tag plus the PRD files of the project. */
export async function readTasks(cwd: string, tag?: string): Promise<TasksWire> {
  await resolveIn(cwd, '.')
  const prds = (await readdir(docsDir(cwd)).catch(() => [])).filter(name => PRD_NAME.test(name)).sort()
  const initialized = await stat(folder(cwd)).then(info => info.isDirectory(), () => false)
  const data = await readData(cwd)
  if (data === undefined) return { initialized, tags: [], tag: tag ?? 'master', tasks: [], prds }
  const byTag = tagged(data)
  const tags = Object.keys(byTag)
  const chosen = tag !== undefined && tag in byTag ? tag : tags.includes('master') ? 'master' : tags[0] ?? 'master'
  return { initialized, tags, tag: chosen, tasks: (byTag[chosen] ?? []).map(item => toTask(item)), prds }
}

/** Set the status of a task (`3`) or subtask (`3.2`) directly in tasks.json. */
export async function setStatus(cwd: string, id: string, status: string, tag?: string): Promise<void> {
  if (!STATUSES.has(status)) throw new HttpError(400, `unknown status: ${status}`)
  await resolveIn(cwd, '.')
  const data = await readData(cwd)
  if (data === undefined) throw new HttpError(404, 'no tasks.json in this project')
  const byTag = tagged(data)
  const chosen = tag !== undefined && tag in byTag ? tag : 'master' in byTag ? 'master' : Object.keys(byTag)[0]
  const [taskId, subId] = id.split('.')
  const task = (chosen === undefined ? [] : byTag[chosen] ?? []).find(item => String(item['id']) === taskId)
  if (task === undefined) throw new HttpError(404, `task ${id} not found`)
  if (subId === undefined) task['status'] = status
  else {
    const sub = (Array.isArray(task['subtasks']) ? task['subtasks'] as Raw[] : []).find(item => String(item['id']) === subId)
    if (sub === undefined) throw new HttpError(404, `subtask ${id} not found`)
    sub['status'] = status
  }
  const temporary = `${tasksFile(cwd)}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`)
  await rename(temporary, tasksFile(cwd))
}

async function prdPath(cwd: string, file: string): Promise<string> {
  if (!PRD_NAME.test(file)) throw new HttpError(400, 'a PRD file name is letters, digits, dot, dash or space, ending in .md or .txt')
  await resolveIn(cwd, '.')
  return join(docsDir(cwd), file)
}

/** Run `task-master-ai` in the project; `command` is replaceable for tests. */
async function runCli(command: string, cwd: string, args: readonly string[]): Promise<string> {
  await resolveIn(cwd, '.')
  try {
    const { stdout } = await exec(command, command === 'npx' ? ['-y', '-p', PACKAGE, 'task-master', ...args] : [...args], { cwd, timeout: 300_000, maxBuffer: 10_000_000, env: { ...process.env, TASKMASTER_SKIP_AUTO_UPDATE: '1' } })
    return stdout
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string }
    throw new HttpError(502, (failure.stderr || failure.stdout || failure.message).trim().split('\n').slice(-6).join('\n'))
  }
}

/** Run one tasks action. */
export async function tasksAction(body: TasksBodyWire, command = 'npx'): Promise<{ ok: true; content?: string; output?: string }> {
  const tagArgs = (tag: string | undefined): string[] => tag === undefined || !/^[A-Za-z0-9_-]+$/.test(tag) ? [] : [`--tag=${tag}`]
  switch (body.action) {
    case 'init':
      return { ok: true, output: await runCli(command, body.cwd, ['init', '--yes']) }
    case 'status':
      await setStatus(body.cwd, body.id, body.status, body.tag)
      return { ok: true }
    case 'add':
      if (body.prompt.trim() === '') throw new HttpError(400, 'the prompt is empty')
      return { ok: true, output: await runCli(command, body.cwd, ['add-task', `--prompt=${body.prompt}`, ...tagArgs(body.tag)]) }
    case 'update':
      if (!/^[0-9]+(\.[0-9]+)?$/.test(body.id) || body.prompt.trim() === '') throw new HttpError(400, 'invalid task id or empty prompt')
      return { ok: true, output: await runCli(command, body.cwd, ['update-task', `--id=${body.id}`, `--prompt=${body.prompt}`, ...tagArgs(body.tag)]) }
    case 'parse': {
      const path = await prdPath(body.cwd, body.file)
      if (!await stat(path).then(() => true, () => false)) throw new HttpError(404, 'no such PRD file')
      return { ok: true, output: await runCli(command, body.cwd, ['parse-prd', path, ...tagArgs(body.tag)]) }
    }
    case 'prd-read':
      return { ok: true, content: await readFile(await prdPath(body.cwd, body.file), 'utf8').catch(() => { throw new HttpError(404, 'no such PRD file') }) }
    case 'prd-write': {
      const path = await prdPath(body.cwd, body.file)
      await mkdir(docsDir(body.cwd), { recursive: true })
      await writeFile(path, body.content)
      return { ok: true }
    }
    case 'prd-delete':
      await rm(await prdPath(body.cwd, body.file), { force: true })
      return { ok: true }
  }
}
