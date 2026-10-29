/**
 * Host half of the workbench: a shell terminal, a file tree with text editing, and git, all confined to the
 * working directory of the selected session. Local use only, behind the same authenticated channel as the
 * rest of the plugin.
 * @module dsh-agent-bridge/workbench
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import type { IPty } from '@lydell/node-pty'
import type {
  WorktreeBodyWire, WorktreeWire, FsActionWire, FsBrowseWire, FsEntryWire, FsFileWire, FsImageWire, GitActionWire, GitChangeWire, GitCommitWire, GitRangeDiffWire, GitRemoteWire, GitStatusWire, TermEventWire,
} from './protocol.ts'

const exec = promisify(execFile)
const FILE_LIMIT = 1_000_000
const REPLAY_LIMIT = 200_000
/** Variables that look like credentials never reach the shell. */
const SECRET_ENV = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

/** Error carrying an HTTP status. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** @returns `target` resolved through symlinks when it stays inside `root`, otherwise throws 403. */
async function inside(root: string, target: string): Promise<string> {
  const base = await realpath(root)
  const within = (path: string): boolean => path === base || path.startsWith(base + sep)
  // Walk up to the nearest existing ancestor so a path that does not exist yet is still judged by where it would land.
  let existing = resolve(target)
  const missing: string[] = []
  for (;;) {
    try {
      existing = await realpath(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) throw new HttpError(404, 'no such path')
      missing.unshift(basename(existing))
      existing = parent
    }
  }
  const resolved = join(existing, ...missing)
  if (!within(resolved)) throw new HttpError(403, 'path is outside the session directory')
  if (missing.length > 0 && existing === resolved) throw new HttpError(404, 'no such path')
  return resolved
}

/** Resolve a request's `cwd` and relative `path` to an absolute path inside the cwd. */
export async function resolveIn(cwd: string, relative: string): Promise<string> {
  if (cwd === '') throw new HttpError(400, 'cwd is required')
  return inside(cwd, join(cwd, relative))
}

/** List one directory; directories first, then files, each alphabetical. */
export async function listDir(cwd: string, relative: string): Promise<FsEntryWire[]> {
  const dir = await resolveIn(cwd, relative)
  const entries = await readdir(dir, { withFileTypes: true })
  const rows = await Promise.all(entries.filter(entry => entry.name !== '.git').map(async (entry) => {
    const info = await stat(join(dir, entry.name)).catch(() => undefined)
    return { name: entry.name, dir: info?.isDirectory() ?? entry.isDirectory(), size: info?.size ?? 0 }
  }))
  return rows.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

/** Read a text file; refuses large and binary files. */
export async function readText(cwd: string, relative: string): Promise<FsFileWire> {
  const path = await resolveIn(cwd, relative)
  const info = await stat(path)
  if (!info.isFile()) throw new HttpError(400, 'not a file')
  if (info.size > FILE_LIMIT) throw new HttpError(413, `file is larger than ${FILE_LIMIT} bytes`)
  const buffer = await readFile(path)
  if (buffer.includes(0)) throw new HttpError(415, 'binary file')
  return { content: buffer.toString('utf8'), mtimeMs: info.mtimeMs }
}

/** Write a text file; refuses when the file changed since `baseMtimeMs` was read. */
export async function writeText(cwd: string, relative: string, content: string, baseMtimeMs: number | undefined): Promise<{ mtimeMs: number }> {
  const path = await resolveIn(cwd, relative)
  if (Buffer.byteLength(content) > FILE_LIMIT) throw new HttpError(413, `content is larger than ${FILE_LIMIT} bytes`)
  const existing = await stat(path).catch(() => undefined)
  if (existing !== undefined && baseMtimeMs !== undefined && Math.abs(existing.mtimeMs - baseMtimeMs) > 1) {
    throw new HttpError(409, 'the file changed on disk since it was opened')
  }
  await writeFile(path, content, 'utf8')
  return { mtimeMs: (await stat(path)).mtimeMs }
}

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' }
const IMAGE_LIMIT = 10_000_000
const UPLOAD_LIMIT = 20_000_000

/** Read an image for preview. */
export async function readImage(cwd: string, relative: string): Promise<FsImageWire> {
  const path = await resolveIn(cwd, relative)
  const mime = IMAGE_MIME[path.split('.').pop()?.toLowerCase() ?? '']
  if (mime === undefined) throw new HttpError(415, 'not an image')
  const info = await stat(path)
  if (info.size > IMAGE_LIMIT) throw new HttpError(413, 'image is too large to preview')
  return { mime, base64: (await readFile(path)).toString('base64') }
}

/** Create, rename, delete or upload inside the session directory. */
export async function fsAction(body: FsActionWire): Promise<{ ok: true }> {
  const root = await realpath(body.cwd.length === 0 ? '/nonexistent' : body.cwd).catch(() => { throw new HttpError(400, 'cwd is required') })
  const clean = (name: string): string => {
    if (name === '' || name.includes('\0') || name.split('/').includes('..')) throw new HttpError(400, 'invalid name')
    return name
  }
  switch (body.action) {
    case 'create': {
      const target = await resolveIn(body.cwd, clean(body.path))
      if (await stat(target).then(() => true, () => false)) throw new HttpError(409, 'already exists')
      if (body.kind === 'dir') await mkdir(target, { recursive: true })
      else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, '', { flag: 'wx' }) }
      break
    }
    case 'rename': {
      const from = await resolveIn(body.cwd, clean(body.path))
      const to = await resolveIn(body.cwd, clean(body.to))
      if (from === root) throw new HttpError(400, 'cannot rename the session directory')
      if (await stat(to).then(() => true, () => false)) throw new HttpError(409, 'target already exists')
      await rename(from, to)
      break
    }
    case 'delete': {
      const target = await resolveIn(body.cwd, clean(body.path))
      if (target === root) throw new HttpError(400, 'cannot delete the session directory')
      await rm(target, { recursive: true })
      break
    }
    case 'upload': {
      const dir = await resolveIn(body.cwd, body.path === '' ? '.' : clean(body.path))
      if (body.name.includes('/') || body.name === '' || body.name === '..') throw new HttpError(400, 'invalid name')
      const data = Buffer.from(body.base64, 'base64')
      if (data.length > UPLOAD_LIMIT) throw new HttpError(413, 'file is too large')
      const target = join(dir, body.name)
      if (await stat(target).then(() => true, () => false)) throw new HttpError(409, 'already exists')
      await writeFile(target, data, { flag: 'wx' })
      break
    }
  }
  return { ok: true }
}

/** Directories under `path` (home when empty); used to pick a working directory. Not confined: the caller is the signed-in local user. */
export async function browseDirs(path: string): Promise<FsBrowseWire> {
  const base = await realpath(path === '' ? homedir() : path)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort((a, b) => a.localeCompare(b))
  const parent = dirname(base)
  return { path: base, parent: parent === base ? undefined : parent, dirs }
}

async function git(cwd: string, args: readonly string[], allowExit1 = false): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 20_000_000, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return stdout
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message: string }
    if (allowExit1 && failure.code === 1) return failure.stdout ?? ''
    throw new HttpError(400, (failure.stderr ?? failure.message).trim() || failure.message)
  }
}

/** `git status` as structured rows. */
export async function gitStatus(cwd: string): Promise<GitStatusWire> {
  await resolveIn(cwd, '.')
  const inRepo = await git(cwd, ['rev-parse', '--is-inside-work-tree']).then(out => out.trim() === 'true', () => false)
  if (!inRepo) return { isRepo: false, branch: '', changes: [] }
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'])
  const parts = out.split('\0').filter(part => part !== '')
  const head = parts.shift() ?? ''
  const branch = head.replace(/^## /, '').replace(/^No commits yet on /, '').split('...')[0] ?? ''
  const changes: GitChangeWire[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    const index = entry[0] ?? ' '
    const worktree = entry[1] ?? ' '
    changes.push({ path: entry.slice(3), index, worktree })
    if (index === 'R' || index === 'C') i++ // the original path of a rename follows
  }
  return { isRepo: true, branch, changes }
}

/** Diff of one path against the index (`staged` false) or HEAD (`staged` true); untracked files diff against nothing. */
export async function gitDiff(cwd: string, path: string, staged: boolean, untracked: boolean): Promise<string> {
  const absolute = await resolveIn(cwd, path)
  if (untracked) return git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', absolute], true)
  return git(cwd, ['diff', '--no-color', ...staged ? ['--cached'] : [], '--', path])
}

/** The latest commits of the current branch. */
export async function gitLog(cwd: string, limit = 30): Promise<GitCommitWire[]> {
  await resolveIn(cwd, '.')
  const out = await git(cwd, ['log', `-${limit}`, '--format=%H%x1f%s%x1f%an%x1f%aI']).catch(() => '')
  return out.split('\n').filter(line => line !== '').map((line) => {
    const [hash = '', subject = '', author = '', date = ''] = line.split('\x1f')
    return { hash, subject, author, date }
  })
}

/** Local branches and the current one. */
export async function gitBranches(cwd: string): Promise<{ current: string; branches: string[] }> {
  await resolveIn(cwd, '.')
  const out = await git(cwd, ['branch', '--format=%(refname:short)%09%(HEAD)'])
  const rows = out.split('\n').filter(line => line !== '').map(line => line.split('\t'))
  return { current: rows.find(row => row[1] === '*')?.[0] ?? '', branches: rows.map(row => row[0] ?? '') }
}

const REF = /^[A-Za-z0-9._\/-]+$/

function checkRef(name: string): string {
  if (name.startsWith('-') || !REF.test(name)) throw new HttpError(400, 'invalid branch or commit name')
  return name
}

/** Remotes, upstream and how far the current branch is ahead of or behind it. */
export async function gitRemote(cwd: string): Promise<GitRemoteWire> {
  await resolveIn(cwd, '.')
  const remotes = (await git(cwd, ['remote']).catch(() => '')).split('\n').filter(line => line !== '')
  const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim() || undefined
  let ahead = 0
  let behind = 0
  if (upstream !== undefined) {
    const [left = '0', right = '0'] = (await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).catch(() => '0\t0')).trim().split(/\s+/)
    behind = Number(left)
    ahead = Number(right)
  }
  return { remotes, upstream, ahead, behind }
}

/** Files and diff of one commit. */
export async function gitShow(cwd: string, hash: string): Promise<GitRangeDiffWire> {
  await resolveIn(cwd, '.')
  checkRef(hash)
  const files = (await git(cwd, ['show', '--format=', '--name-only', hash])).split('\n').filter(line => line !== '')
  return { files, diff: await git(cwd, ['show', '--format=%h %s%n%an, %aI%n', '--no-color', hash]) }
}

/** Files and diff of `head` against its merge base with `base`. */
export async function gitCompare(cwd: string, base: string, head: string): Promise<GitRangeDiffWire> {
  await resolveIn(cwd, '.')
  const range = `${checkRef(base)}...${checkRef(head)}`
  const files = (await git(cwd, ['diff', '--name-only', range])).split('\n').filter(line => line !== '')
  return { files, diff: await git(cwd, ['diff', '--no-color', range]) }
}

/**
 * Draft a commit message for the staged changes with the Claude executable (`-p`, diff on stdin).
 * Runs only when the user presses the button; the diff goes to the user's own Claude.
 */
export async function gitDraftMessage(cwd: string, executable: string): Promise<string> {
  await resolveIn(cwd, '.')
  const diff = await git(cwd, ['diff', '--cached', '--no-color'])
  if (diff.trim() === '') throw new HttpError(400, 'nothing is staged')
  const prompt = 'Write a concise git commit message (an imperative subject line of at most 72 characters, optionally a blank line and a short body) for this staged diff. Reply with the message only.'
  return await new Promise<string>((resolveMessage, reject) => {
    const child = execFile(executable === '' ? 'claude' : executable, ['-p', prompt], { cwd, timeout: 90_000, maxBuffer: 5_000_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(new HttpError(502, (stderr || error.message).trim()))
      else resolveMessage(stdout.trim().replace(/^```\w*\n?|\n?```$/g, '').trim())
    })
    child.stdin?.end(diff.slice(0, 60_000))
  })
}

/** Run one git action. */
export async function gitAction(body: GitActionWire): Promise<{ ok: true }> {
  if (body.action === 'init') {
    await resolveIn(body.cwd, '.')
    await git(body.cwd, ['init', '-q', '-b', 'main'])
    return { ok: true }
  }
  await resolveIn(body.cwd, '.')
  switch (body.action) {
    case 'stage':
      await git(body.cwd, ['add', '--', ...body.paths])
      break
    case 'unstage':
      await git(body.cwd, ['reset', '-q', 'HEAD', '--', ...body.paths]).catch(() => git(body.cwd, ['rm', '--cached', '-q', '-r', '--', ...body.paths]))
      break
    case 'discard': {
      // Tracked paths go back to HEAD (staged and working copy); untracked paths are deleted.
      const status = await gitStatus(body.cwd)
      const untracked = new Set(status.changes.filter(change => change.index === '?').map(change => change.path))
      const tracked = body.paths.filter(path => !untracked.has(path))
      const fresh = body.paths.filter(path => untracked.has(path))
      if (tracked.length > 0) {
        const added = status.changes.filter(change => tracked.includes(change.path) && change.index === 'A').map(change => change.path)
        const restorable = tracked.filter(path => !added.includes(path))
        if (added.length > 0) await git(body.cwd, ['rm', '-q', '-f', '--', ...added])
        if (restorable.length > 0) await git(body.cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restorable])
      }
      if (fresh.length > 0) await git(body.cwd, ['clean', '-f', '-q', '--', ...fresh])
      break
    }
    case 'commit':
      if (body.message.trim() === '') throw new HttpError(400, 'commit message is empty')
      await git(body.cwd, ['commit', '-m', body.message])
      break
    case 'checkout':
      if (body.branch.startsWith('-') || body.branch.trim() === '') throw new HttpError(400, 'invalid branch name')
      await git(body.cwd, body.create === true ? ['checkout', '-b', body.branch] : ['checkout', body.branch])
      break
    case 'deleteBranch':
      await git(body.cwd, ['branch', body.force === true ? '-D' : '-d', checkRef(body.branch)])
      break
    case 'fetch':
      await git(body.cwd, ['fetch', '--prune'])
      break
    case 'pull':
      await git(body.cwd, ['pull', '--ff-only'])
      break
    case 'push':
      await git(body.cwd, ['push'])
      break
    case 'publish': {
      const branch = (await git(body.cwd, ['branch', '--show-current'])).trim()
      const remote = (await git(body.cwd, ['remote'])).split('\n')[0]?.trim()
      if (remote === undefined || remote === '') throw new HttpError(400, 'this repository has no remote')
      await git(body.cwd, ['push', '-u', remote, branch])
      break
    }
    case 'initialCommit':
      await git(body.cwd, ['add', '-A'])
      await git(body.cwd, ['commit', '-m', 'Initial commit'])
      break
    case 'undoLastCommit':
      // Local only: the commit's changes stay staged.
      await git(body.cwd, ['reset', '--soft', 'HEAD~1'])
      break
  }
  return { ok: true }
}

interface Terminal {
  readonly pty: IPty
  readonly listeners: Set<(event: TermEventWire) => void>
  replay: string
  exit: number | undefined
}

/** Shell sessions keyed by id; they outlive tab switches and are all killed with the plugin. */
export class TerminalManager {
  readonly #terminals = new Map<string, Terminal>()

  open(cwd: string, cols: number, rows: number): string {
    // Loaded lazily so a missing native build disables only the terminal.
    const pty = (createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty'))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !SECRET_ENV.test(key))) as Record<string, string>
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    const process_ = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: cwd === '' ? homedir() : cwd, env: { ...env, TERM: 'xterm-256color' } })
    const id = randomUUID()
    const terminal: Terminal = { pty: process_, listeners: new Set(), replay: '', exit: undefined }
    process_.onData((data) => {
      terminal.replay = (terminal.replay + data).slice(-REPLAY_LIMIT)
      for (const listener of terminal.listeners) listener({ data })
    })
    process_.onExit(({ exitCode }) => {
      terminal.exit = exitCode
      for (const listener of terminal.listeners) listener({ exit: exitCode })
    })
    this.#terminals.set(id, terminal)
    return id
  }

  #get(id: string): Terminal {
    const terminal = this.#terminals.get(id)
    if (terminal === undefined) throw new HttpError(404, 'unknown terminal')
    return terminal
  }

  subscribe(id: string, listener: (event: TermEventWire) => void): () => void {
    const terminal = this.#get(id)
    if (terminal.replay !== '') listener({ data: terminal.replay })
    if (terminal.exit !== undefined) listener({ exit: terminal.exit })
    terminal.listeners.add(listener)
    return () => { terminal.listeners.delete(listener) }
  }

  input(id: string, data: string): void { const terminal = this.#get(id); if (terminal.exit === undefined) terminal.pty.write(data) }

  resize(id: string, cols: number, rows: number): void {
    const terminal = this.#get(id)
    if (terminal.exit === undefined) terminal.pty.resize(Math.max(2, cols), Math.max(2, rows))
  }

  close(id: string): void {
    const terminal = this.#terminals.get(id)
    if (terminal === undefined) return
    if (terminal.exit === undefined) terminal.pty.kill()
    this.#terminals.delete(id)
  }

  closeAll(): void { for (const id of [...this.#terminals.keys()]) this.close(id) }
}

/** The worktrees of the repository, the first being the main one. */
export async function gitWorktrees(cwd: string): Promise<WorktreeWire[]> {
  await resolveIn(cwd, '.')
  const out = await git(cwd, ['worktree', 'list', '--porcelain'])
  const result: WorktreeWire[] = []
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(line => line !== '')
    const path = lines.find(line => line.startsWith('worktree '))?.slice(9)
    if (path === undefined) continue
    result.push({
      path,
      branch: lines.find(line => line.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? '',
      head: (lines.find(line => line.startsWith('HEAD ')) ?? '').slice(5, 12),
      main: result.length === 0,
      locked: lines.some(line => line.startsWith('locked')),
    })
  }
  return result
}

/** Create, remove or merge a worktree. New worktrees go to `<repo>-worktrees/<branch>` unless a path is given. */
export async function gitWorktreeAction(body: WorktreeBodyWire): Promise<{ ok: true; path?: string }> {
  await resolveIn(body.cwd, '.')
  const list = await gitWorktrees(body.cwd)
  const main = list[0]?.path ?? body.cwd
  switch (body.action) {
    case 'create': {
      const branch = checkRef(body.branch)
      const path = body.path ?? join(`${main}-worktrees`, branch.replace(/\//g, '-'))
      await mkdir(dirname(path), { recursive: true })
      await git(main, ['worktree', 'add', '-b', branch, path])
      return { ok: true, path }
    }
    case 'remove': {
      if (!list.some(item => item.path === body.path && !item.main)) throw new HttpError(400, 'not a linked worktree of this repository')
      await git(main, ['worktree', 'remove', ...body.force === true ? ['--force'] : [], body.path])
      return { ok: true }
    }
    case 'merge': {
      const branch = checkRef(body.branch)
      await git(main, ['merge', '--no-ff', '--no-edit', branch])
      return { ok: true }
    }
  }
}

/** Clone a repository into a new folder under `parent`. */
export async function gitClone(url: string, parent: string, name: string): Promise<{ path: string }> {
  if (!/^(https?:\/\/|git@|ssh:\/\/|\/|file:\/\/)/.test(url) || url.startsWith('-')) throw new HttpError(400, 'unsupported repository address')
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new HttpError(400, 'invalid folder name')
  const base = await realpath(parent).catch(() => { throw new HttpError(400, 'the parent folder does not exist') })
  const target = join(base, name)
  if (await stat(target).then(() => true, () => false)) throw new HttpError(409, 'the folder already exists')
  try {
    await exec('git', ['clone', '--', url, target], { timeout: 600_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    throw new HttpError(400, (failure.stderr ?? failure.message).trim().split('\n').slice(-3).join(' '))
  }
  return { path: target }
}
