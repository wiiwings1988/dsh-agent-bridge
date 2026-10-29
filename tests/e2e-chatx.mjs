/**
 * Acceptance for the conversation extras of dsh-agent-bridge: usage, search, archive and restore, model and
 * effort, attachments, drafts, slash commands, MCP servers, skills, git identity. Needs a dev instance started as
 * for e2e.mjs, with `claudeExecutable` set to tests/fixtures/fake-claude.py and GIT_CONFIG_GLOBAL pointing at a
 * scratch file. The fake passes calls through to the real executable except in "record" mode, where it logs what
 * the SDK was asked to start and exits with an error.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const CONFIG_DIR = `${DEV_HOME}/claude-config`
const EVIDENCE = fileURLToPath(new URL('../.evidence/phase2/', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/make-claude-fixtures.mjs', import.meta.url))
const WORKTREE = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE_LOG = process.env.EE_FAKE_LOG ?? `${DEV_HOME}/fake-claude.log`
const MODE = '/tmp/ee-fake-mode'
mkdirSync(EVIDENCE, { recursive: true })
const token = [...readFileSync(`${DEV_HOME}/logs/dev-web.log`, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (token === undefined) throw new Error('no login token in the dev log; is the dev instance running?')
execFileSync('node', [FIXTURES, CONFIG_DIR, WORKTREE], { encoding: 'utf8' })
// The fixture sessions point at these folders; the beta folder is left out on purpose (a deleted project).
for (const name of ['alpha', 'gamma']) mkdirSync(`/tmp/ee-fixture/${name}`, { recursive: true })
rmSync('/tmp/ee-fixture/beta', { recursive: true, force: true })
rmSync(FAKE_LOG, { force: true }); rmSync(MODE, { force: true })

const results = []
const pageErrors = []
async function step(name, fn) {
  try { await fn(); results.push(true); console.log(`PASS  ${name}`) } catch (error) {
    results.push(false); console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 5).join('\n      ')}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

// A local stand-in for the speech service the instance is configured to use (voiceBaseUrl http://127.0.0.1:16790).
const speech = []
const wav = (() => { const data = Buffer.alloc(1600); const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]) })()
const speechServer = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks)
    speech.push({ url: request.url, type: request.headers['content-type'], body })
    if (request.url === '/v1/audio/transcriptions') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ text: 'dictated words' })) }
    else { response.setHeader('content-type', 'audio/wav'); response.end(wav) }
  })
})
await new Promise((resolve, reject) => { speechServer.once('error', reject); speechServer.listen(16790, '127.0.0.1', resolve) })

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] })
const page = await context.newPage()
page.on('pageerror', e => pageErrors.push(e.message))
const tid = id => page.locator(`[data-testid="${id}"]`)
// The Workspace browser lists the sessions when the dsh-ui-workspace-hub bundle provides its external
// session source; otherwise the plugin's own page does. Decided on the first load.
let hub = false
// Session rows; folder rows carry no aria-selected.
const rowsOf = p => hub ? p.locator('[role="treeitem"][aria-selected]') : p.locator('[data-testid="ext-list"] [role="treeitem"][aria-selected]')
const row = title => rowsOf(page).filter({ hasText: title })

/** Close the first-run notices of a fresh home (notice buttons, then the sign-in dialog, which closes on Escape). */
async function dismissOn(p) {
  for (const name of [/^Continue$/, /^Configure later$/]) await p.locator('button', { hasText: name }).click({ timeout: 6000 }).catch(() => {})
  for (let i = 0; i < 4 && await p.locator('[role="dialog"]').count() > 0; i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(400) }
}
/** Show every fixture row: Ungrouped expanded and paged out in the Workspace browser, or the Claude / Codex page. */
async function openPageOn(p) {
  if (hub) {
    const ungrouped = p.getByRole('treeitem').filter({ hasText: /^(Ungrouped|未分组)$/ }).first()
    await ungrouped.waitFor({ timeout: 15000 })
    if (await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
    const more = p.locator('button', { hasText: /more sessions|更多会话/ })
    while (await more.count() > 0) { await more.first().click(); await p.waitForTimeout(300) }
    await rowsOf(p).first().waitFor({ timeout: 15000 })
    return
  }
  const list = p.locator('[data-testid="ext-list"]')
  if (!await list.isVisible().catch(() => false)) await p.getByRole('button', { name: 'Claude / Codex' }).first().click()
  await list.waitFor({ timeout: 15000 })
  await rowsOf(p).first().waitFor({ timeout: 15000 })
}
/** Open the plugin's configuration page under the sidebar's Plugins entry. */
async function openSettingsOn(p) {
  // The page hides the core sidebar, where the Plugins entry lives.
  if (await p.locator('[data-testid="ext-list-back"]').isVisible().catch(() => false)) await p.locator('[data-testid="ext-list-back"]').click()
  await p.getByRole('button', { name: 'Plugins', exact: true }).first().click()
  await p.getByText('dsh-agent-bridge', { exact: true }).first().click()
  await p.locator('[data-testid="ext-settings-card"]').waitFor({ timeout: 10000 })
}

async function load() {
  await page.goto(`${BASE}/?token=${token}`)
  await dismissOn(page)
  await page.getByRole('treeitem').first().waitFor({ timeout: 15000 })
  hub = await page.getByRole('button', { name: 'Claude / Codex' }).count() === 0
  await page.waitForTimeout(500)
}
async function reveal(title) {
  await openPageOn(page)
  await page.waitForTimeout(1500)
  await row(title).first().click({ timeout: 15000 }).catch(async (error) => {
    throw new Error(`${error.message.split('\n')[0]} | rows=${(await rowsOf(page).allTextContents()).map(x => x.slice(0, 25)).join(' / ')}`)
  })
  await tid('ext-title').filter({ hasText: title }).waitFor({ timeout: 10000 })
}
/** datetime-local value for `ms` from now; a zero seconds field is nudged because the browser drops it from the value and refuses the filled string. */
const stampIn = (ms) => { const at = new Date(Date.now() + ms); const text = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 19); return text.endsWith(':00') ? `${text.slice(0, 17)}01` : text }
const choose = async (id, label) => { await tid(id).selectOption({ label }) }
const fakeLog = () => existsSync(FAKE_LOG) ? readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []

await page.addInitScript(() => {
  window.__notes = []
  document.hasFocus = () => false
  window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted') }; constructor(title, options) { window.__notes.push([title, options?.body]) } }
  try { window.localStorage.setItem('agent-bridge:notify', '1') } catch {}
})
await load()

/** Run a session verb from the header's More actions menu (rename, fork, archive, delete). */
async function menuAction(id) {
  const item = page.locator(`[data-testid="${id}"]`)
  if (!await item.isVisible().catch(() => false)) await page.locator('[data-testid="ext-more"]').click()
  await item.click()
}

await step('usage: the session total is shown (tokens in / out)', async () => {
  await reveal('list files')
  const usage = tid('ext-usage')
  await usage.waitFor({ timeout: 10000 })
  assert(await usage.getAttribute('data-input') === '400' && await usage.getAttribute('data-output') === '80', `usage ${await usage.getAttribute('data-input')}/${await usage.getAttribute('data-output')}`)
  assert(/4\.6k/.test(await usage.textContent() ?? ''), 'input should include cache tokens (4.6k)')
})

await step('search: a word inside a conversation finds its session and opens it', async () => {
  await tid('ext-search-toggle').click()
  await tid('ext-search').fill('beta answer')
  await tid('ext-search-hit').first().waitFor({ timeout: 15000 })
  assert(await tid('ext-search-hit').count() === 1, 'expected exactly the beta session')
  assert(/beta answer/.test(await tid('ext-search-hit').first().textContent() ?? ''), 'snippet should show the matching passage')
  await tid('ext-search-hit').first().click()
  await tid('ext-title').filter({ hasText: 'beta question' }).waitFor({ timeout: 10000 })
  await tid('ext-search').fill('no-such-phrase-anywhere')
  // The hit list of the previous query stays on screen until this query answers.
  await tid('ext-search-hits').waitFor({ timeout: 15000 })
  const cleared = await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-search-hit"]').length === 0, null, { timeout: 15000 }).then(() => true, () => false)
  assert(cleared, 'a missing phrase must give no hits')
  await tid('ext-search').fill('')
})

await step('archive: the row leaves the list, the settings card lists it, restore brings it back', async () => {
  await menuAction('ext-archive')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-panel"]').length === 0 || true)
  await page.waitForTimeout(800)
  assert(await row('beta question').count() === 0, 'the archived row is still in the tree')
  await openSettingsOn(page)
  await tid('ext-archived-row').filter({ hasText: 'beta question' }).waitFor({ timeout: 10000 })
  await tid('ext-restore').first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-archived-row"]').length === 0)
  await openPageOn(page)
  await row('beta question').first().waitFor({ timeout: 10000 })
})

await step('model list and slash commands come from the engine', async () => {
  await reveal('list files')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-model"] option').length > 1, null, { timeout: 60000 })
  const options = await tid('ext-model').locator('option').allTextContents()
  console.log(`      models: ${options.length - 1}`)
  await tid('ext-input').fill('/')
  await tid('ext-slash-item').first().waitFor({ timeout: 15000 })
  const count = await tid('ext-slash-item').count()
  await tid('ext-input').fill('/goal')
  await tid('ext-slash-item').filter({ has: page.locator('code', { hasText: '/goal' }) }).first().waitFor({ timeout: 5000 })
  await tid('ext-slash-item').first().click()
  assert((await tid('ext-input').inputValue()).startsWith('/goal '), 'picking a command should fill it in')
  assert(count >= 1, 'no slash commands offered')
  await tid('ext-input').fill('')
})

await step('the default model and effort options name what the engine will use', async () => {
  const named = /^(默认|Default) ?[（(].+[)）]$/
  await reveal('list files')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-model"] option').length > 2, null, { timeout: 60000 })
  await tid('ext-model').selectOption('')
  const claude = await tid('ext-model-default').innerText()
  console.log(`      claude: ${claude}`)
  assert(named.test(claude), `the Claude default should carry a model name, got "${claude}"`)
  assert(await tid('ext-effort').count() === 1, 'the effort picker should be offered while the Claude model is left to the engine')
  await reveal(/New Codex session|新建 Codex 会话/)
  try {
    // The effort default is named only while the model is left to the engine.
    await tid('ext-model').selectOption('')
    await page.waitForFunction(pattern => ['ext-model-default', 'ext-effort-default'].every(id => new RegExp(pattern).test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '')), named.source, { timeout: 60000 }).catch(() => {})
    const codex = [await tid('ext-model-default').innerText(), await tid('ext-effort-default').innerText()]
    console.log(`      codex: ${codex.join(' / ')}`)
    assert(codex.every(text => named.test(text)), `the Codex defaults should carry names, got ${JSON.stringify(codex)}`)
  } finally {
    await reveal('list files')
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-model"] option').length > 2, null, { timeout: 60000 })
  }
})

await step('opening a session in another folder names the default model at once, not after the engine answers', async () => {
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await other.newPage()
  const defaultText = () => fresh.locator('[data-testid="ext-model-default"]').innerText().catch(() => '')
  try {
    await fresh.goto(`${BASE}/?token=${token}`)
    await dismissOn(fresh)
    await openPageOn(fresh)
    await fresh.waitForTimeout(1500)
    await rowsOf(fresh).filter({ hasText: 'list files' }).first().click()
    await fresh.waitForFunction(() => /[（(]/.test(document.querySelector('[data-testid="ext-model-default"]')?.textContent ?? ''), null, { timeout: 60000 })
    // The fixture session in the dsh worktree is the only one in that folder, so its list was never loaded before.
    await rowsOf(fresh).filter({ hasText: 'same folder as the dsh workspace' }).first().click()
    await fresh.locator('[data-testid="ext-title"]', { hasText: 'same folder' }).waitFor({ timeout: 10000 })
    await fresh.waitForTimeout(1000)
    const shown = await defaultText()
    assert(/[（(]/.test(shown), `one second after opening, the default model reads "${shown}"`)
  } finally { await other.close() }
})

let model
let efforts = []
await step('the chosen model and effort reach the Claude process; the attachment is taken with the message', async () => {
  try {
  writeFileSync(MODE, 'record')
  const options = await tid('ext-model').locator('option').evaluateAll(els => els.map(e => ({ value: e.value, label: e.textContent })))
  model = options.find(o => o.value !== '')
  await tid('ext-model').selectOption(model.value)
  efforts = await tid('ext-effort').locator('option').evaluateAll(els => els.map(e => e.value).filter(Boolean)).catch(() => [])
  if (efforts.length > 0) await tid('ext-effort').selectOption(efforts[0])
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await tid('ext-attach-input').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
  await tid('ext-attachment').waitFor()
  await tid('ext-input').fill('describe the picture')
  await tid('ext-send').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ext-attachment"]').length === 0)
  const deadline = Date.now() + 30000
  while (fakeLog().length === 0 && Date.now() < deadline) await page.waitForTimeout(300)
  const call = fakeLog().at(-1)
  assert(call !== undefined, 'the executable was never started')
  const joined = call.args.join(' ')
  assert(joined.includes(`--model ${model.value}`), `model flag missing: ${joined.slice(0, 300)}`)
  if (efforts.length > 0) assert(joined.includes(`--effort ${efforts[0]}`), `effort flag missing: ${joined.slice(0, 300)}`)
  await page.waitForFunction(() => /fake claude|exited|error/i.test(document.querySelector('[data-testid="ext-error"]')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})
  } finally { rmSync(MODE, { force: true }) }
})

await step('the picked model and effort are the default in another browser, for an existing and a new session', async () => {
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fresh = await other.newPage()
  try {
    await fresh.goto(`${BASE}/?token=${token}`)
    await dismissOn(fresh)
    await openPageOn(fresh)
    await fresh.waitForTimeout(1500)
    for (const title of ['gamma', /New Claude session|新建 Claude 会话/]) {
      await rowsOf(fresh).filter({ hasText: title }).first().click({ timeout: 15000 })
      await fresh.waitForFunction(value => document.querySelector('[data-testid="ext-model"]')?.value === value, model.value, { timeout: 15000 })
        .catch(async () => { throw new Error(`${title}: model shows "${await fresh.locator('[data-testid="ext-model"]').inputValue()}", expected ${model.value}`) })
      if (efforts.length > 0) {
        const shown = await fresh.locator('[data-testid="ext-effort"]').inputValue()
        assert(shown === efforts[0], `${title}: effort shows "${shown}", expected ${efforts[0]}`)
      }
    }
    const refused = await fresh.evaluate(async () => (await fetch('/api/agent-bridge/choice', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'other', model: 'x', effort: '' }) })).status)
    assert(refused === 400, `a choice for an unknown engine should be refused, got ${refused}`)
  } finally { await other.close() }
})

await step('a model id typed by hand is sent to the Claude process', async () => {
  try {
    writeFileSync(MODE, 'record')
    rmSync(FAKE_LOG, { force: true })
    await reveal('gamma')
    await tid('ext-model').selectOption('__custom__')
    await tid('ext-model-custom').fill('my-own-model')
    await tid('ext-input').fill('hi')
    await tid('ext-send').click()
    // Opening the session may also start the executable to list models, so look for the message's call among all calls.
    const typed = () => fakeLog().some(call => call.args.join(' ').includes('--model my-own-model'))
    const deadline = Date.now() + 30000
    while (!typed() && Date.now() < deadline) await page.waitForTimeout(300)
    assert(typed(), `no call carried the typed model: ${fakeLog().map(call => call.args.join(' ').slice(0, 120)).join(' | ')}`)
    await tid('ext-model').selectOption('')
  } finally { rmSync(MODE, { force: true }) }
})

await step('sending from a long session read at the top brings the panel down to the new message', async () => {
  try {
    writeFileSync(MODE, 'record')
    await reveal('long conversation')
    await page.getByText('long reply 40', { exact: true }).waitFor({ timeout: 10000 })
    await tid('ext-panel').evaluate((el) => { el.scrollTop = 0 })
    await page.waitForTimeout(300)
    await tid('ext-input').fill('are you there')
    await tid('ext-send').click()
    await tid('ext-pending').or(tid('ext-error')).first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(500)
    const gap = await tid('ext-panel').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)
    assert(gap <= 2, `the panel stayed ${Math.round(gap)} px above the bottom, so the sent message and its answer are out of sight`)
  } finally { rmSync(MODE, { force: true }) }
})

await step('draft: unsent text survives a reload and is cleared by sending', async () => {
  await reveal('gamma')
  await tid('ext-input').fill('half written thought')
  await page.waitForTimeout(1500)
  await load()
  await reveal('gamma')
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-input"]')?.value === 'half written thought', null, { timeout: 10000 })
  await tid('ext-input').fill('')
  await page.waitForTimeout(1500)
  await load()
  await reveal('gamma')
  await page.waitForTimeout(1000)
  assert(await tid('ext-input').inputValue() === '', 'a cleared draft came back')
})

await step('text typed while the saved draft is still loading is kept', async () => {
  await load()
  await page.route('**/api/agent-bridge/draft?*', async (route) => { await new Promise(resolve => setTimeout(resolve, 2500)); await route.continue() })
  try {
    await reveal('gamma')
    await tid('ext-input').fill('typed right away')
    await page.waitForTimeout(4000)
    const shown = await tid('ext-input').inputValue()
    assert(shown === 'typed right away', `the late draft replaced the typed text with "${shown}"`)
  } finally {
    await page.unroute('**/api/agent-bridge/draft?*')
    await tid('ext-input').fill('')
    await page.waitForTimeout(1500)
  }
})

await step('MCP: add and remove a server from the Extensions tab', async () => {
  await reveal('list files')
  await tid('ext-tab-extensions').click()
  await tid('ext-mcp-name').fill('e2e-demo')
  await tid('ext-mcp-command').fill('echo')
  await tid('ext-mcp-args').fill('hi')
  await tid('ext-mcp-add').click()
  await tid('ext-mcp-item').filter({ hasText: 'e2e-demo' }).waitFor({ timeout: 60000 }).catch(async (error) => {
    throw new Error(`${error.message.split('\n')[0]} | status=${await tid('ext-status').textContent().catch(() => '-')} | items=${await tid('ext-mcp-item').allTextContents()}`)
  })
  const config = JSON.parse(readFileSync(`${CONFIG_DIR}/.claude.json`, 'utf8'))
  assert(config.mcpServers?.['e2e-demo']?.command === 'echo', 'the server is not in the Claude configuration')
  await tid('ext-mcp-item').filter({ hasText: 'e2e-demo' }).locator('[data-testid="ext-mcp-remove"]').click()
  await tid('ext-mcp-item').filter({ hasText: 'e2e-demo' }).locator('[data-testid="ext-mcp-remove-confirm"]').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="ext-mcp-item"]')].some(el => el.getAttribute('data-name') === 'e2e-demo'), null, { timeout: 60000 })
  assert(JSON.parse(readFileSync(`${CONFIG_DIR}/.claude.json`, 'utf8')).mcpServers?.['e2e-demo'] === undefined, 'the server is still configured')
})

await step('skills: add, see, remove', async () => {
  await tid('ext-skill-name').fill('e2e-skill')
  await tid('ext-skill-description').fill('Say hello in tests')
  await tid('ext-skill-body').fill('Say hello.')
  await tid('ext-skill-add').click()
  await tid('ext-skill-item').filter({ hasText: 'e2e-skill' }).waitFor({ timeout: 10000 })
  assert(/description: Say hello in tests/.test(readFileSync(`${CONFIG_DIR}/skills/e2e-skill/SKILL.md`, 'utf8')), 'SKILL.md missing the description')
  await tid('ext-skill-item').filter({ hasText: 'e2e-skill' }).locator('[data-testid="ext-skill-remove"]').click()
  await tid('ext-skill-item').filter({ hasText: 'e2e-skill' }).locator('[data-testid="ext-skill-remove-confirm"]').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="ext-skill-item"]')].some(el => el.getAttribute('data-name') === 'e2e-skill'), null, { timeout: 10000 })
  assert(!existsSync(`${CONFIG_DIR}/skills/e2e-skill`), 'the skill folder is still on disk')
})

await step('git identity: saved to the global git config', async () => {
  await tid('ext-git-name').fill('E2E Tester'); await tid('ext-git-email').fill('e2e@example.com')
  await tid('ext-git-save').click()
  await tid('ext-status').filter({ hasText: /Saved|已保存/ }).waitFor({ timeout: 10000 })
  const gitconfig = process.env.GIT_CONFIG_GLOBAL ?? `${DEV_HOME}/gitconfig`
  assert(/name = E2E Tester/.test(readFileSync(gitconfig, 'utf8')), 'user.name not in the scratch git config')
  await page.screenshot({ path: `${EVIDENCE}04-extensions.png` })
})

await step('account: the Extensions tab shows the sign-in state of the engine', async () => {
  const text = await tid('ext-account').textContent()
  assert(text !== null && text.trim() !== '', 'account line is empty')
  console.log(`      account line: ${text.replace(/[\w.+-]+@[\w.-]+/g, '<email>')}`)
})

await step('a running turn is marked in the tree, and its end raises a notification', async () => {
  try {
    writeFileSync(MODE, 'record-hold')
    await reveal('gamma')
    await tid('ext-input').fill('ping')
    await tid('ext-send').click()
    await page.waitForFunction(() => [...document.querySelectorAll('[role="treeitem"]')].some(el => /▶ gamma/.test(el.textContent ?? '')), null, { timeout: 15000 })
    await page.waitForFunction(() => ![...document.querySelectorAll('[role="treeitem"]')].some(el => /▶ gamma/.test(el.textContent ?? '')), null, { timeout: 30000 })
    const notes = await page.evaluate(() => window.__notes)
    assert(notes.some(([title]) => /gamma/.test(title)), `no notification for the finished turn: ${JSON.stringify(notes)}`)
  } finally { rmSync(MODE, { force: true }) }
})

await step('schedule: a message set for a few seconds ahead is sent to that session when due; a cancelled one is not', async () => {
  try {
    writeFileSync(MODE, 'record')
    rmSync(FAKE_LOG, { force: true })
    await reveal('gamma')
    // Earlier runs leave sent or failed "scheduled hello" items in the plugin state; this run's item is the pending
    // one, and once due it is the one that raises the sent count.
    const hello = tid('ext-scheduled-item').filter({ hasText: 'scheduled hello' })
    const sentBefore = await hello.and(page.locator('[data-status="sent"]')).count()
    await tid('ext-input').fill('scheduled hello')
    await tid('ext-schedule').click()
    await tid('ext-schedule-at').fill(stampIn(5000))
    await tid('ext-schedule-add').click()
    await hello.and(page.locator('[data-status="pending"]')).waitFor({ timeout: 10000 })
    assert(await tid('ext-input').inputValue() === '', 'the message box should be emptied once scheduled')
    await tid('ext-input').fill('never sent')
    await tid('ext-schedule').click()
    await tid('ext-schedule-at').fill(stampIn(3_600_000))
    await tid('ext-schedule-add').click()
    await tid('ext-scheduled-item').filter({ hasText: 'never sent' }).locator('[data-testid="ext-schedule-cancel"]').click()
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="ext-scheduled-item"]')].some(el => /never sent/.test(el.textContent ?? '')), null, { timeout: 10000 })
    await hello.and(page.locator('[data-status="sent"]')).nth(sentBefore).waitFor({ timeout: 30000 })
    const deadline = Date.now() + 20000
    while (fakeLog().length === 0 && Date.now() < deadline) await page.waitForTimeout(300)
    const calls = fakeLog().filter(call => call.args.some(arg => arg.includes('--resume=00000000-0000-4000-8000-000000000005')))
    assert(calls.length === 1, `expected one resumed turn in the gamma session, saw ${calls.length}`)
  } finally { rmSync(MODE, { force: true }) }
})

await step('a session whose folder was deleted says so instead of failing obscurely; its scheduled message is marked failed', async () => {
  await reveal('beta question')
  await tid('ext-input').fill('hello?')
  await tid('ext-send').click()
  await tid('ext-error').filter({ hasText: /no longer exists/ }).waitFor({ timeout: 15000 })
  // Earlier runs leave failed "later hello" items behind, so this run's item is the one that raises the count.
  const failed = tid('ext-scheduled-item').filter({ hasText: 'later hello' }).and(page.locator('[data-status="failed"]'))
  const before = await failed.count()
  await tid('ext-input').fill('later hello')
  await tid('ext-schedule').click()
  await tid('ext-schedule-at').fill(stampIn(3000))
  await tid('ext-schedule-add').click()
  await failed.nth(before).waitFor({ timeout: 30000 })
  assert(/no longer exists/.test(await failed.nth(before).textContent() ?? ''), 'the reason should be shown')
})

await step('voice: dictation goes to the speech service and the transcript lands in the message box; a reply can be read aloud', async () => {
  await reveal('list files')
  await tid('ext-input').fill('')
  await tid('ext-dictate').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-dictate"]')?.getAttribute('data-state') === 'recording')
  await page.waitForTimeout(1500)
  await tid('ext-dictate').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-input"]')?.value === 'dictated words', null, { timeout: 20000 })
  const upload = speech.find(call => call.url === '/v1/audio/transcriptions')
  assert(upload !== undefined && /^multipart\/form-data/.test(upload.type) && upload.body.length > 500, 'the recording should reach the service as a multipart upload')
  assert(await tid('ext-message').filter({ hasText: 'list files' }).locator('[data-testid="ext-speak"]').count() === 0, 'a message without text should have no read-aloud button')
  await tid('ext-message').filter({ hasText: 'two' }).locator('[data-testid="ext-speak"]').first().click()
  const deadline = Date.now() + 15000
  while (!speech.some(call => call.url === '/v1/audio/speech') && Date.now() < deadline) await page.waitForTimeout(200)
  const spoken = speech.find(call => call.url === '/v1/audio/speech')
  assert(spoken !== undefined && /two/.test(JSON.parse(spoken.body.toString()).input), 'the reply text should be sent for speech')
  assert(await tid('ext-voice-error').count() === 0, 'no voice error expected')
  await tid('ext-input').fill('')
})

await step('new session: browse folders, clone a repository into one, and the session starts there', async () => {
  const source = '/tmp/ee-pick/source'
  rmSync('/tmp/ee-pick', { recursive: true, force: true })
  mkdirSync(source, { recursive: true })
  execFileSync('sh', ['-c', `cd ${source} && git init -q && echo hi > a.txt && git add . && git -c user.email=e@x -c user.name=E commit -q -m first`])
  try {
    await openPageOn(page)
    await rowsOf(page).filter({ hasText: /New Claude session|新建 Claude 会话/ }).first().click()
    await tid('ext-browse').click()
    await page.waitForFunction(() => /^\//.test(document.querySelector('[data-testid="ext-dir-path"]')?.textContent ?? ''), null, { timeout: 10000 })
    for (let guard = 0; guard < 10 && await tid('ext-dir-up').count() > 0; guard++) {
      const before = await tid('ext-dir-path').textContent()
      await tid('ext-dir-up').click()
      await page.waitForFunction((was) => document.querySelector('[data-testid="ext-dir-path"]')?.textContent !== was, before)
    }
    assert(await tid('ext-dir-path').textContent() === '/', 'should have reached the root')
    for (const name of ['private', 'tmp', 'ee-pick']) {
      await tid('ext-dir-entry').filter({ hasText: new RegExp(`^${name}$`) }).click()
      await page.waitForFunction((n) => document.querySelector('[data-testid="ext-dir-path"]')?.textContent?.endsWith(`/${n}`), name)
    }
    await tid('ext-clone-url').fill(source)
    await tid('ext-clone-name').fill('copy')
    await tid('ext-clone').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="ext-cwd"]')?.value === '/private/tmp/ee-pick/copy', null, { timeout: 30000 })
    assert(readFileSync('/tmp/ee-pick/copy/a.txt', 'utf8') === 'hi\n', 'the clone is missing its file')
    await tid('ext-clone-url').count()
  } finally { rmSync('/tmp/ee-pick', { recursive: true, force: true }) }
})

await step('no uncaught page errors', async () => { assert(pageErrors.length === 0, pageErrors.join(' | ')) })
await browser.close()
speechServer.close()
rmSync(MODE, { force: true })
rmSync('/tmp/ee-fixture', { recursive: true, force: true })
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} steps passed`)
process.exit(passed === results.length ? 0 : 1)
