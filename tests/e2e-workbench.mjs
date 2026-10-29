/**
 * Acceptance for the workbench tabs (terminal, files, git) of dsh-agent-bridge. Needs a dev instance started
 * with CLAUDE_CONFIG_DIR=<DEV_HOME>/claude-config (see e2e.mjs). Builds a scratch git repository and one session
 * whose working directory is that repository (the instance's `claudeExecutable` must be tests/fixtures/fake-claude.py,
 * which stands in for Claude when drafting a commit message), drives the tabs in a browser, and checks the effects on disk.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const CONFIG_DIR = `${DEV_HOME}/claude-config`
const EVIDENCE = fileURLToPath(new URL('../.evidence/phase2/', import.meta.url))
mkdirSync(EVIDENCE, { recursive: true })
const REPO = '/tmp/ee-wb'
const REMOTE = '/tmp/ee-wb-remote.git'
const WORKTREES = '/tmp/ee-wb-worktrees'
const TM_LOG = '/tmp/ee-tm.log'
const SESSION = '00000000-0000-4000-8000-0000000000aa'
const PROJECT_DIR = `${CONFIG_DIR}/projects/-tmp-ee-wb`
const token = [...readFileSync(`${DEV_HOME}/logs/dev-web.log`, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (token === undefined) throw new Error('no login token in the dev log; is the dev instance running?')

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' })
function setup() {
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(`${REPO}/sub`, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@example.com'); git('config', 'user.name', 'E2E')
  writeFileSync(`${REPO}/a.txt`, 'one\n'); writeFileSync(`${REPO}/sub/b.txt`, 'bee\n')
  git('add', '.'); git('commit', '-q', '-m', 'first')
  writeFileSync(`${REPO}/c.txt`, 'cee\n') // untracked
  mkdirSync(`${REPO}/.taskmaster/tasks`, { recursive: true })
  writeFileSync(`${REPO}/.taskmaster/tasks/tasks.json`, JSON.stringify({ master: { tasks: [
    { id: 1, title: 'Write the plan', description: 'd', status: 'done', dependencies: [], subtasks: [{ id: 1, title: 'Outline', status: 'pending' }] },
    { id: 2, title: 'Build it', description: 'd', status: 'pending', dependencies: [1] },
  ] } }))
  rmSync(TM_LOG, { force: true })
  git('add', '.taskmaster'); git('commit', '-q', '-m', 'tasks')
  mkdirSync(PROJECT_DIR, { recursive: true })
  const now = Date.now()
  const record = (type, content, n) => JSON.stringify({
    parentUuid: null, isSidechain: false, type, message: { role: type, content }, uuid: `${SESSION.slice(0, 24)}${String(n).padStart(12, '0')}`,
    timestamp: new Date(now + n).toISOString(), cwd: REPO, sessionId: SESSION, version: '2.0.0', userType: 'external',
  })
  writeFileSync(`${PROJECT_DIR}/${SESSION}.jsonl`, `${record('user', 'workbench probe', 1)}\n`)
}
function cleanup() {
  rmSync(REPO, { recursive: true, force: true })
  rmSync(REMOTE, { recursive: true, force: true })
  rmSync(WORKTREES, { recursive: true, force: true })
  rmSync(TM_LOG, { force: true })
  rmSync(`${PROJECT_DIR}/${SESSION}.jsonl`, { force: true })
  rmSync(PROJECT_DIR, { recursive: true, force: true })
}
setup()

const results = []
const pageErrors = []
async function step(name, fn) {
  try { await fn(); results.push(true); console.log(`PASS  ${name}`) } catch (error) {
    results.push(false); console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 5).join('\n      ')}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => pageErrors.push(e.message))
const tid = id => page.locator(`[data-testid="${id}"]`)
const shot = name => page.locator('[data-testid="ext-tabs"]').locator('..').screenshot({ path: `${EVIDENCE}${name}.png` })

await page.goto(`${BASE}/?token=${token}`)
for (const name of [/^Continue$/, /^Configure later$/]) {
  await page.locator('button', { hasText: name }).click({ timeout: 6000 }).catch(() => {})
}
// A fresh home also asks to sign in; the dialog closes on Escape.
for (let i = 0; i < 4 && await page.locator('[role="dialog"]').count() > 0; i++) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
}
await page.waitForTimeout(500)

await step('open the session: tabs appear for a session with a working directory', async () => {
  const ungrouped = page.getByRole('treeitem').filter({ hasText: /^(Ungrouped|未分组)$/ }).first()
  await ungrouped.waitFor({ timeout: 10000 })
  if (await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
  const more = page.locator('button', { hasText: /more sessions|更多会话/ })
  while (await more.count() > 0) { await more.first().click(); await page.waitForTimeout(300) }
  await page.getByRole('treeitem').filter({ hasText: 'workbench probe' }).first().click({ timeout: 15000 })
  await tid('ext-tabs').waitFor({ timeout: 10000 })
  assert(await tid('ext-tabs').locator('button').count() === 6, 'expected six tabs')
})

await step('terminal: typed command runs in the session directory and its output is shown', async () => {
  await tid('ext-tab-terminal').click()
  const screen = tid('wb-term-screen')
  await screen.waitFor({ timeout: 10000 })
  await page.waitForTimeout(6000) // the login shell reads the user's rc files
  await screen.click()
  await page.keyboard.type('echo wb-$((6*7)) && pwd -P')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /wb-42/.test(document.querySelector('[data-testid="wb-term-screen"]')?.textContent ?? '') && /private\/tmp\/ee-wb/.test(document.querySelector('[data-testid="wb-term-screen"]')?.textContent ?? ''), null, { timeout: 40000 })
  await shot('01-terminal')
})

await step('terminal: output survives a trip to another tab', async () => {
  await tid('ext-tab-chat').click()
  await tid('ext-tab-terminal').click()
  const text = await tid('wb-term-screen').first().textContent()
  assert(/wb-42/.test(text ?? ''), 'the earlier output was lost')
})

await step('terminal: a second terminal runs on its own, and closing it leaves the first alone', async () => {
  await tid('wb-term-add').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="wb-term-tab"]').length === 2)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wb-term-screen"]')].every(el => el.getAttribute('data-tid')) , null, { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(6000)
  const second = page.locator('[data-testid="wb-term-screen"]:visible')
  await second.click()
  await page.keyboard.type('echo second-$((5*5))')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wb-term-screen"]')].some(el => /second-25/.test(el.textContent ?? '') && el.offsetParent !== null), null, { timeout: 40000 })
  const first = await page.locator('[data-testid="wb-term-screen"]').first().textContent()
  assert(!/second-25/.test(first ?? ''), 'the second terminal wrote into the first')
  await tid('wb-term-close').nth(1).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="wb-term-tab"]').length === 1)
  assert(/wb-42/.test(await page.locator('[data-testid="wb-term-screen"]').first().textContent() ?? ''), 'the first terminal lost its output')
})

const cm = () => page.locator('[data-testid="wb-editor"] .cm-content')
const typeInto = async (text) => { await cm().click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(text) }

await step('files: tree lists the repository, a file opens highlighted, an edit is saved to disk', async () => {
  await tid('ext-tab-files').click()
  await tid('wb-file').filter({ hasText: 'a.txt' }).click()
  await page.waitForFunction(() => /^one/.test(document.querySelector('[data-testid="wb-editor"] .cm-content')?.textContent ?? ''))
  assert(await tid('wb-dir').filter({ hasText: 'sub' }).count() === 1, 'sub directory missing from the tree')
  assert(await tid('wb-dir').filter({ hasText: '.git' }).count() === 0, '.git should be hidden')
  await typeInto('edited')
  await tid('wb-save').click()
  await tid('wb-file-status').filter({ hasText: /Saved|已保存/ }).waitFor({ timeout: 10000 })
  assert(readFileSync(`${REPO}/a.txt`, 'utf8') === 'edited', 'the file on disk was not updated')
})

await step('files: a source file gets syntax colours', async () => {
  writeFileSync(`${REPO}/code.js`, 'const answer = 42 // note\nfunction f() { return "s" }\n')
  await tid('ext-tab-git').click(); await tid('ext-tab-files').click()
  await tid('wb-file').filter({ hasText: 'code.js' }).click()
  await page.waitForFunction(() => /const answer/.test(document.querySelector('[data-testid="wb-editor"] .cm-content')?.textContent ?? ''))
  const colours = await page.evaluate(() => new Set([...document.querySelectorAll('[data-testid="wb-editor"] .cm-line span')].map(el => getComputedStyle(el).color)).size)
  assert(colours >= 3, `expected several token colours, got ${colours}`)
  await shot('02-files')
})

await step('files: new file, new folder, rename, upload and delete change the disk', async () => {
  await tid('wb-new-file').click()
  await tid('wb-new-file-input').fill('made.txt')
  await tid('wb-new-file-submit').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-file-path"]')?.textContent?.startsWith('made.txt'))
  assert(readFileSync(`${REPO}/made.txt`, 'utf8') === '', 'new file missing on disk')
  await tid('wb-new-dir').click(); await tid('wb-new-dir-input').fill('newdir'); await tid('wb-new-dir-submit').click()
  await tid('wb-dir').filter({ hasText: 'newdir' }).waitFor()
  await tid('wb-file').filter({ hasText: 'made.txt' }).click()
  await tid('wb-rename').click(); await tid('wb-rename-input').fill('newdir/moved.txt'); await tid('wb-rename-submit').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="wb-file"][data-path="made.txt"]'))
  assert(execFileSync('ls', [`${REPO}/newdir`], { encoding: 'utf8' }).trim() === 'moved.txt', 'rename did not move the file')
  await tid('wb-dir').filter({ hasText: 'newdir' }).click()
  await tid('wb-upload-input').setInputFiles({ name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded\n') })
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-file"][data-path="newdir/up.txt"]'))
  assert(readFileSync(`${REPO}/newdir/up.txt`, 'utf8') === 'uploaded\n', 'uploaded content differs')
  await tid('wb-delete').click()
  assert(readFileSync(`${REPO}/newdir/up.txt`, 'utf8') === 'uploaded\n' && execFileSync('test', ['-d', `${REPO}/newdir`]) !== undefined, 'delete must wait for the confirmation')
  await tid('wb-delete-confirm').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="wb-dir"][data-path="newdir"]'))
  assert(execFileSync('sh', ['-c', `test ! -e ${REPO}/newdir && echo gone`], { encoding: 'utf8' }).trim() === 'gone', 'folder still on disk')
})

await step('files: an image is previewed', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(`${REPO}/dot.png`, png)
  await tid('ext-tab-git').click(); await tid('ext-tab-files').click()
  await tid('wb-file').filter({ hasText: 'dot.png' }).click()
  await tid('wb-image').waitFor({ timeout: 10000 })
  assert(await tid('wb-image').evaluate(img => img.complete && img.naturalWidth === 1), 'the image did not decode')
})

await step('files: saving over a file changed elsewhere is refused and leaves the disk alone', async () => {
  await tid('wb-file').filter({ hasText: 'a.txt' }).click()
  await page.waitForFunction(() => /^edited/.test(document.querySelector('[data-testid="wb-editor"] .cm-content')?.textContent ?? ''))
  execFileSync('sh', ['-c', `sleep 1; printf 'elsewhere\\n' > ${REPO}/a.txt`])
  await typeInto('mine')
  await tid('wb-save').click()
  await tid('wb-file-status').filter({ hasText: /changed on disk/ }).waitFor({ timeout: 10000 })
  assert(readFileSync(`${REPO}/a.txt`, 'utf8') === 'elsewhere\n', 'the other edit was overwritten')
})

await step('git: changes are listed; stage, diff, commit and a new branch land in the repository', async () => {
  rmSync(`${REPO}/dot.png`); rmSync(`${REPO}/code.js`); rmSync(`${REPO}/newdir`, { recursive: true, force: true }); rmSync(`${REPO}/made.txt`, { force: true })
  await tid('ext-tab-git').click()
  const unstaged = tid('wb-unstaged')
  await unstaged.filter({ hasText: 'a.txt' }).waitFor({ timeout: 10000 })
  assert(await unstaged.filter({ hasText: 'c.txt' }).count() === 1, 'untracked file missing')
  await unstaged.filter({ hasText: 'a.txt' }).locator('[data-testid="wb-change-path"]').click()
  await tid('wb-diff').waitFor()
  assert(/\+elsewhere/.test(await tid('wb-diff').textContent() ?? ''), 'diff does not show the change')
  await unstaged.filter({ hasText: 'a.txt' }).locator('[data-testid="wb-stage"]').click()
  await tid('wb-staged').filter({ hasText: 'a.txt' }).waitFor({ timeout: 10000 })
  assert(git('diff', '--cached', '--name-only').trim() === 'a.txt', 'the index does not hold a.txt')
  await tid('wb-commit-message').fill('e2e commit')
  await tid('wb-commit').click()
  await tid('wb-commit-row').filter({ hasText: 'e2e commit' }).waitFor({ timeout: 10000 })
  assert(git('log', '-1', '--format=%s').trim() === 'e2e commit', 'git log does not show the commit')
  await tid('wb-new-branch').fill('feat-x')
  await tid('wb-create-branch').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-branch"]')?.value === 'feat-x', null, { timeout: 10000 })
  assert(git('branch', '--show-current').trim() === 'feat-x', 'branch was not switched')
  await shot('03-git')
})

await step('git: discard asks first, then restores a tracked file and deletes an untracked one', async () => {
  writeFileSync(`${REPO}/a.txt`, 'dirty\n')
  await tid('wb-git-refresh').click()
  const row = tid('wb-unstaged').filter({ hasText: 'a.txt' })
  await row.waitFor({ timeout: 10000 })
  await row.locator('[data-testid="wb-discard"]').click()
  assert(readFileSync(`${REPO}/a.txt`, 'utf8') === 'dirty\n', 'discard ran without confirmation')
  await row.locator('[data-testid="wb-discard-confirm"]').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="wb-unstaged"]')].some(el => el.getAttribute('data-path') === 'a.txt'))
  assert(readFileSync(`${REPO}/a.txt`, 'utf8') === 'elsewhere\n', 'file was not restored')
  const untracked = tid('wb-unstaged').filter({ hasText: 'c.txt' })
  await untracked.locator('[data-testid="wb-discard"]').click(); await untracked.locator('[data-testid="wb-discard-confirm"]').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="wb-unstaged"]')].some(el => el.getAttribute('data-path') === 'c.txt'))
  assert(execFileSync('sh', ['-c', `test ! -e ${REPO}/c.txt && echo gone`], { encoding: 'utf8' }).trim() === 'gone', 'untracked file still on disk')
})

await step('git: publish, push, fetch and pull against a remote; ahead and behind are shown', async () => {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', REMOTE])
  git('remote', 'add', 'origin', REMOTE)
  await tid('wb-git-refresh').click()
  await tid('wb-publish').waitFor({ timeout: 10000 })
  await tid('wb-publish').click()
  assert(execFileSync('git', ['-C', REMOTE, 'branch', '--list', 'feat-x'], { encoding: 'utf8' }).trim() === '', 'publish ran without confirmation')
  await tid('wb-publish-confirm').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-sync"]')?.textContent?.includes('origin/feat-x'), null, { timeout: 15000 })
  assert(/feat-x/.test(execFileSync('git', ['-C', REMOTE, 'branch', '--list'], { encoding: 'utf8' })), 'the branch is not on the remote')
  writeFileSync(`${REPO}/p.txt`, 'p\n'); git('add', 'p.txt'); git('commit', '-q', '-m', 'to push')
  await tid('wb-git-refresh').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-sync"]')?.getAttribute('data-ahead') === '1')
  await tid('wb-push').click(); await tid('wb-push-confirm').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-sync"]')?.getAttribute('data-ahead') === '0', null, { timeout: 15000 })
  assert(execFileSync('git', ['-C', REMOTE, 'log', '-1', '--format=%s', 'feat-x'], { encoding: 'utf8' }).trim() === 'to push', 'push did not reach the remote')
  const other = '/tmp/ee-wb-other'
  rmSync(other, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '-b', 'feat-x', REMOTE, other])
  execFileSync('git', ['-C', other, '-c', 'user.email=o@example.com', '-c', 'user.name=O', 'commit', '-q', '--allow-empty', '-m', 'from elsewhere'])
  execFileSync('git', ['-C', other, 'push', '-q'])
  rmSync(other, { recursive: true, force: true })
  await tid('wb-fetch').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-sync"]')?.getAttribute('data-behind') === '1', null, { timeout: 15000 })
  await tid('wb-pull').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-sync"]')?.getAttribute('data-behind') === '0', null, { timeout: 15000 })
  assert(git('log', '-1', '--format=%s').trim() === 'from elsewhere', 'pull did not bring the commit')
})

await step('git: commit diff, branch comparison, commit message draft, undo last commit, delete branch', async () => {
  await tid('wb-commit-row').filter({ hasText: 'to push' }).locator('button').click()
  await page.waitForFunction(() => /p\.txt/.test(document.querySelector('[data-testid="wb-diff"]')?.textContent ?? ''))
  await tid('wb-compare-base').selectOption('main'); await tid('wb-compare-head').selectOption('feat-x'); await tid('wb-compare').click()
  await page.waitForFunction(() => /p\.txt/.test(document.querySelector('[data-testid="wb-diff-files"]')?.textContent ?? ''))
  writeFileSync(`${REPO}/q.txt`, 'q\n'); git('add', 'q.txt')
  await tid('wb-git-refresh').click()
  await tid('wb-staged').filter({ hasText: 'q.txt' }).waitFor()
  await tid('wb-draft-message').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-commit-message"]')?.value === 'feat: drafted by fake claude', null, { timeout: 20000 })
  git('commit', '-q', '-m', 'to undo')
  await tid('wb-git-refresh').click()
  await tid('wb-commit-row').filter({ hasText: 'to undo' }).waitFor()
  await tid('wb-undo-commit').click(); await tid('wb-undo-commit-confirm').click()
  await tid('wb-staged').filter({ hasText: 'q.txt' }).waitFor({ timeout: 10000 })
  assert(git('log', '-1', '--format=%s').trim() === 'from elsewhere', 'the commit was not undone')
  git('reset', '-q', 'HEAD'); rmSync(`${REPO}/q.txt`)
  git('checkout', '-q', 'main')
  await tid('wb-git-refresh').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="wb-branch"]')?.value === 'main')
  await tid('wb-compare-base').selectOption('feat-x')
  await tid('wb-delete-branch').click()
  assert(/feat-x/.test(git('branch', '--list')), 'delete ran without confirmation')
  await tid('wb-delete-branch-confirm').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="wb-branch"] option')].some(o => o.value === 'feat-x'), null, { timeout: 10000 })
})

await step('worktrees: create one, open a session in it, merge its work back, remove it', async () => {
  await tid('ext-tab-git').click()
  await tid('wb-worktree-name').fill('wt-x')
  await tid('wb-worktree-create').click()
  await tid('wb-worktree').filter({ has: page.locator('code', { hasText: 'wt-x' }) }).waitFor({ timeout: 10000 })
  assert(readFileSync(`${WORKTREES}/wt-x/a.txt`, 'utf8') !== undefined, 'worktree folder missing')
  const tree = tid('wb-worktree').filter({ has: page.locator('code', { hasText: 'wt-x' }) })
  await tree.locator('[data-testid="wb-worktree-open"]').click()
  await tid('ext-cwd').waitFor({ timeout: 10000 })
  // The draft fills the folder field after it mounts.
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-cwd"]')?.value.endsWith('/ee-wb-worktrees/wt-x'), null, { timeout: 10000 })
    .catch(() => {})
  const folder = await tid('ext-cwd').inputValue()
  assert(folder.endsWith('/ee-wb-worktrees/wt-x'), `new session folder is ${folder}`)
  execFileSync('sh', ['-c', `cd ${WORKTREES}/wt-x && echo w > wt.txt && git add wt.txt && git -c user.email=e@x -c user.name=E commit -q -m "in worktree"`])
  await page.getByRole('treeitem').filter({ hasText: 'workbench probe' }).first().click()
  await tid('ext-tab-git').click()
  await tid('wb-git-refresh').click()
  const again = tid('wb-worktree').filter({ has: page.locator('code', { hasText: 'wt-x' }) })
  await again.locator('[data-testid="wb-worktree-merge"]').click()
  await again.locator('[data-testid="wb-worktree-merge-confirm"]').click()
  await page.waitForFunction(() => /in worktree/.test(document.querySelector('[data-testid="wb-git"]')?.textContent ?? ''), null, { timeout: 15000 })
  assert(readFileSync(`${REPO}/wt.txt`, 'utf8') === 'w\n', 'merged file missing in the main worktree')
  await again.locator('[data-testid="wb-worktree-remove"]').click()
  await again.locator('[data-testid="wb-worktree-remove-confirm"]').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="wb-worktree"][data-branch="wt-x"]'), null, { timeout: 10000 })
  assert(execFileSync('sh', ['-c', `test ! -e ${WORKTREES}/wt-x && echo gone`], { encoding: 'utf8' }).trim() === 'gone', 'worktree folder still exists')
})

await step('tasks: TaskMaster tasks are listed, a status change reaches tasks.json, a PRD is written, model-backed actions ask first', async () => {
  await tid('ext-tab-tasks').click()
  await tid('tm-task').first().waitFor({ timeout: 10000 })
  assert(await tid('tm-task').count() === 3, 'two tasks and one subtask expected')
  assert(await tid('tm-task').filter({ hasText: 'Outline' }).getAttribute('data-id') === '1.1', 'subtask id should be dotted')
  await tid('tm-task').filter({ hasText: 'Build it' }).locator('[data-testid="tm-status"]').selectOption('in-progress')
  await page.waitForFunction(() => document.querySelector('[data-testid="tm-task"][data-id="2"]')?.getAttribute('data-status') === 'in-progress')
  assert(JSON.parse(readFileSync(`${REPO}/.taskmaster/tasks/tasks.json`, 'utf8')).master.tasks[1].status === 'in-progress', 'tasks.json was not updated')
  await tid('tm-prd-name').fill('plan.md'); await tid('tm-prd-create').click()
  await tid('tm-prd-editor').waitFor({ timeout: 10000 })
  await tid('tm-prd-editor').fill('# Plan\nBuild it.'); await tid('tm-prd-save').click()
  await tid('tm-prd').filter({ hasText: 'plan.md' }).waitFor()
  assert(readFileSync(`${REPO}/.taskmaster/docs/plan.md`, 'utf8') === '# Plan\nBuild it.', 'PRD content not on disk')
  await tid('tm-prompt').fill('Add login'); await tid('tm-add').click()
  assert(!existsSync(TM_LOG), 'the model-backed action ran without confirmation')
  await tid('tm-add-confirm').click()
  await tid('tm-output').filter({ hasText: 'ran add-task' }).waitFor({ timeout: 15000 })
  await tid('tm-parse').click(); await tid('tm-parse-confirm').click()
  await page.waitForFunction(() => /ran parse-prd/.test(document.querySelector('[data-testid="tm-output"]')?.textContent ?? ''), null, { timeout: 15000 })
  const calls = readFileSync(TM_LOG, 'utf8').trim().split('\n')
  assert(calls[0] === 'add-task --prompt=Add login' && calls[1].startsWith('parse-prd ') && calls[1].endsWith('.taskmaster/docs/plan.md'), `cli calls: ${calls.join(' | ')}`)
  await shot('04-tasks')
})

await step('no uncaught page errors', async () => { assert(pageErrors.length === 0, pageErrors.join(' | ')) })
await browser.close()
cleanup()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} steps passed`)
process.exit(passed === results.length ? 0 : 1)
