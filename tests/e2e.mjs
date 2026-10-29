/**
 * Phase 1 acceptance for dsh-agent-bridge (Claude Code, read-only) against a running dev instance
 * (default http://127.0.0.1:16777, token read from the dev log). The instance must have been started
 * with CLAUDE_CONFIG_DIR=<DEV_HOME>/claude-config. The run regenerates the synthetic fixtures first, so
 * it is idempotent; it never reads the user's real ~/.claude.
 * Every step prints PASS or FAIL; the exit code is non-zero when any step fails.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const CONFIG_DIR = `${DEV_HOME}/claude-config`
const EVIDENCE = fileURLToPath(new URL('../.evidence/phase1/', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/make-claude-fixtures.mjs', import.meta.url))
const WORKTREE = fileURLToPath(new URL('../../../../', import.meta.url))
mkdirSync(EVIDENCE, { recursive: true })

const token = [...readFileSync(`${DEV_HOME}/logs/dev-web.log`, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (token === undefined) throw new Error('no login token in the dev log; is the dev instance running?')

const manifest = JSON.parse(execFileSync('node', [FIXTURES, CONFIG_DIR, WORKTREE], { encoding: 'utf8' }))
const TITLES = ['alpha one', 'list files', 'beta question', 'same folder as the dsh workspace', 'gamma', 'long conversation']
const BIG_LIMIT = '100'
const SMALL_LIMIT = '3'

const results = []
const pageErrors = []
async function step(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 4).join('\n      ')}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => pageErrors.push(e.message))
const list = () => page.locator('[data-testid="ext-list"]')
// The Workspace browser lists the sessions when the dsh-ui-workspace-hub bundle provides its external
// session source; otherwise the plugin's own page does. Decided after the first load.
let hub = false
// Session rows only: folder rows carry no aria-selected, and one fixture folder shares a session's title.
const rowSelector = () => hub ? '[role="treeitem"][aria-selected]' : '[data-testid="ext-list"] [role="treeitem"][aria-selected]'
const sessionRows = () => hub ? page.locator('[role="treeitem"][aria-selected]') : list().locator('[role="treeitem"][aria-selected]')
const row = title => sessionRows().filter({ hasText: title })
// Panel-only screenshots: the sidebar also lists the user's real Codex threads.
const shot = name => panel().screenshot({ path: `${EVIDENCE}${name}.png` })
const panel = () => page.locator('[data-testid="ext-panel"]')
const summary = () => page.locator('[data-testid="ext-summary"]')
const card = () => page.locator('[data-testid="ext-settings-card"]')
const messageCount = async () => Number(await summary().getAttribute('data-count'))
const fixtureRows = () => sessionRows().evaluateAll(
  (els, titles) => els.filter(e => titles.some(t => (e.textContent ?? '').includes(t))).length, TITLES)

/** The configuration page sits on the plugin's own page under the sidebar's Plugins entry. */
async function openSettings() {
  if (await card().isVisible().catch(() => false)) return
  // The page hides the core sidebar, where the Plugins entry lives.
  if (await page.locator('[data-testid="ext-list-back"]').isVisible().catch(() => false)) await page.locator('[data-testid="ext-list-back"]').click()
  await page.getByRole('button', { name: 'Plugins', exact: true }).first().click()
  await page.getByText('dsh-agent-bridge', { exact: true }).first().click()
  await card().waitFor({ timeout: 10000 })
}
async function writeLimit(value) {
  await openSettings()
  const input = page.locator('[data-testid="ext-limit"]')
  if ((await input.inputValue()) !== value) {
    await input.fill(value)
    await page.locator('[data-testid="ext-save"]').click()
    await page.locator('[data-testid="ext-saved"]').waitFor({ timeout: 10000 })
  }
  await openPage()
}
/**
 * Show every fixture row: in the Workspace browser, open Ungrouped (the fixtures have no Workspace)
 * and page through its "Show N more" button; otherwise open the Claude / Codex page.
 */
async function openPage() {
  if (hub) {
    const ungrouped = page.getByRole('treeitem').filter({ hasText: /^(Ungrouped|未分组)$/ }).first()
    await ungrouped.waitFor({ timeout: 10000 })
    if (await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
    const more = page.locator('button', { hasText: /more sessions|更多会话/ })
    while (await more.count() > 0) {
      await more.first().click()
      await page.waitForTimeout(300)
    }
    return
  }
  if (!await list().isVisible().catch(() => false)) await page.getByRole('button', { name: 'Claude / Codex' }).first().click()
  await list().waitFor({ timeout: 10000 })
}

async function dismissOverlays() {
  for (const name of [/^Continue$/, /^Configure later$/]) {
    const button = page.locator('button', { hasText: name })
    try {
      await button.waitFor({ state: 'visible', timeout: 6000 })
      await button.click()
    } catch {
      // The overlay is not shown on this load.
    }
  }
  // A fresh home also asks to sign in; the dialog closes on Escape.
  for (let i = 0; i < 4 && await page.locator('[role="dialog"]').count() > 0; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(500)
}

await page.goto(`${BASE}/?token=${token}`)
await dismissOverlays()
await page.getByRole('treeitem').first().waitFor({ timeout: 15000 })
hub = await page.getByRole('button', { name: 'Claude / Codex' }).count() === 0
console.log(`      sessions listed by: ${hub ? 'the Workspace browser' : 'the plugin page'}`)

/** Run a session verb from the header's More actions menu (rename, fork, archive, delete). */
async function menuAction(id) {
  const item = page.locator(`[data-testid="${id}"]`)
  if (!await item.isVisible().catch(() => false)) await page.locator('[data-testid="ext-more"]').click()
  await item.click()
}

await step(`baseline: session limit is ${BIG_LIMIT}`, async () => {
  await writeLimit(BIG_LIMIT)
  await page.reload()
  await dismissOverlays()
})

await step('gate 1: files on disk = SDK list = rows in the tree', async () => {
  const onDisk = readdirSync(`${CONFIG_DIR}/projects`, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => readdirSync(`${CONFIG_DIR}/projects/${d.name}`).filter(f => f.endsWith('.jsonl'))).length
  const listed = await page.evaluate(async () => (await (await fetch('/api/agent-bridge/sessions', { credentials: 'same-origin' })).json()).sessions.filter(s => s.id.startsWith('claude:')).length)
  await openPage()
  await row(TITLES[0]).first().waitFor({ timeout: 10000 }).catch(() => {})
  const shown = await fixtureRows()
  console.log(`      files=${onDisk} sdk=${listed} rows=${shown}`)
  assert(onDisk === manifest.length, `fixture mismatch: ${onDisk} files vs ${manifest.length} generated`)
  assert(listed === onDisk, `SDK list has ${listed}, disk has ${onDisk}`)
  assert(shown === onDisk, `tree shows ${shown}, disk has ${onDisk}`)
})

await step('rows are grouped by folder: newest folder first, newest session first inside a folder', async () => {
  const sessions = await page.evaluate(async () => (await (await fetch('/api/agent-bridge/sessions', { credentials: 'same-origin' })).json()).sessions)
  const folders = new Map()
  for (const s of sessions) folders.set(s.cwd, [...folders.get(s.cwd) ?? [], s])
  const expected = [...folders.values()].map(rows => rows.toSorted((a, b) => b.updatedAt - a.updatedAt))
    .toSorted((a, b) => b[0].updatedAt - a[0].updatedAt).flat()
    .map(s => TITLES.find(t => s.title.includes(t))).filter(t => t !== undefined)
  const titles = await sessionRows().evaluateAll(els => els.map(e => e.textContent ?? ''))
  const shown = titles.map(text => TITLES.find(t => text.includes(t))).filter(t => t !== undefined)
  if (hub) {
    // The fixtures all sit under Ungrouped, which the browser orders newest first; TITLES runs oldest first.
    const newestFirst = TITLES.toReversed()
    assert(JSON.stringify(shown) === JSON.stringify(newestFirst), `order ${shown.join(' | ')}, expected ${newestFirst.join(' | ')}`)
    return
  }
  assert(expected.length === TITLES.length, `the API lists ${expected.length} of ${TITLES.length} fixtures`)
  assert(JSON.stringify(shown) === JSON.stringify(expected), `order ${shown.join(' | ')}, expected ${expected.join(' | ')}`)
  const folderRows = await list().locator('[data-testid="ext-folder"]').evaluateAll(els => els.map(e => e.getAttribute('title')))
  assert(folderRows.includes('/tmp/ee-fixture/alpha'), `the alpha fixture folder is a group: ${folderRows.slice(0, 5).join(' | ')}`)
})

await step('every session row carries its engine mark, and the mark is drawn', async () => {
  const marks = await sessionRows().evaluateAll(els => els.filter(e => e.hasAttribute('aria-selected')).map((e) => {
    const mark = e.querySelector('[data-engine]')
    return {
      text: e.textContent ?? '',
      // dsh draws a blank New Session row without its leading cell or "..." menu until the first prompt.
      blank: e.querySelector('button[aria-label]') === null,
      engine: mark?.getAttribute('data-engine') ?? null,
      drawn: mark !== null && [getComputedStyle(mark).backgroundImage, getComputedStyle(mark).maskImage, getComputedStyle(mark).webkitMaskImage].some(v => (v ?? '').startsWith('url(')),
    }
  }))
  const sessions = marks.filter(m => !m.blank)
  const missing = sessions.filter(m => m.engine === null).map(m => m.text)
  assert(missing.length === 0, `rows without a mark: ${missing.join(' | ')}`)
  assert(sessions.filter(m => !m.drawn).length === 0, 'a mark has no icon image')
  for (const title of TITLES) {
    const hit = marks.find(m => m.text.includes(title))
    assert(hit?.engine === 'claude', `"${title}" should be marked claude, got ${hit?.engine}`)
  }
  const engines = [...new Set(sessions.map(m => m.engine))].sort()
  console.log(`      engines on screen: ${engines.join(', ')}`)
  assert(engines.every(e => ['claude', 'codex', 'dsh'].includes(e ?? '')), `unexpected engines: ${engines}`)
})

const target = manifest[1]
await step('gate 2: opening a session shows exactly its messages (text, thinking, tool call, tool result)', async () => {
  await row('list files').first().click()
  await page.locator('[data-testid="ext-summary"][data-status="ready"]').waitFor({ timeout: 10000 })
  assert((await page.locator('[data-testid="ext-title"]').innerText()) === 'list files', 'panel title should be the clicked session')
  assert(await row('list files').first().getAttribute('aria-selected') === 'true', 'clicked row should be selected')
  const shownCount = Number(await summary().getAttribute('data-count'))
  const fileRecords = readFileSync(target.file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    .filter(r => r.type === 'user' || r.type === 'assistant').length
  const rendered = await page.locator('[data-testid="ext-message"]').count()
  const kinds = {}
  for (const k of ['text', 'thinking', 'tool-use']) kinds[k] = await page.locator(`[data-testid="ext-${k}"]`).count()
  console.log(`      file=${fileRecords} shown=${shownCount} rendered=${rendered} ${JSON.stringify(kinds)}`)
  // Each tool result joins its call's card, so the two result-only records are not drawn as messages.
  assert(shownCount === fileRecords && rendered === fileRecords - 2, `message count mismatch: file ${fileRecords}, summary ${shownCount}, rendered ${rendered}`)
  assert(kinds.thinking === 2 && kinds['tool-use'] === 2 && kinds.text === 4, `block kinds: ${JSON.stringify(kinds)}`)
  await shot('02-transcript')
})

await step('gate 2d: the app keeps its own brand (no plugin mark, name or title)', async () => {
  assert(await page.locator('[data-testid="brand-mark"], [data-testid="brand-name"]').count() === 0, 'the plugin must not replace the sidebar brand')
  assert(!(await page.title()).includes('DSH Hub'), `the plugin retitled the tab: ${await page.title()}`)
})

await step('gate 2b: replies are rendered as Markdown, not raw text', async () => {
  const reply = page.locator('[data-testid="ext-message"][data-role="assistant"] [data-testid="ext-text"]').first()
  assert(await reply.locator('strong').count() === 1, 'bold should become a strong element')
  assert(await reply.locator('li').count() === 2, 'list should become two list items')
  assert(await reply.locator('code').count() >= 2, 'inline code should become code elements')
  assert(!(await reply.innerText()).includes('**'), 'no raw Markdown markers should remain')
})

await step('gate 2c: tool calls are folded cards; opening one shows the terminal output or the diff', async () => {
  const cards = page.locator('[data-testid="ext-tool-use"]')
  assert(await cards.count() === 2, 'two tool cards')
  assert(await cards.nth(0).getAttribute('data-tool') === 'Bash' && await cards.nth(1).getAttribute('data-tool') === 'Edit', 'tool names')
  assert(await cards.nth(0).getAttribute('data-state') === 'done', 'a finished call shows the done state')
  assert(!(await cards.nth(0).innerText()).includes('file-b'), 'output stays hidden while the card is folded')
  await cards.nth(0).getByText('Bash', { exact: false }).first().click()
  await page.waitForFunction(() => (document.querySelector('[data-tool="Bash"]')?.textContent ?? '').includes('file-b'), null, { timeout: 5000 })
  await cards.nth(1).getByText('Edit', { exact: false }).first().click()
  await page.getByText('new-line', { exact: false }).first().waitFor({ timeout: 5000 })
  assert(await page.getByText('old-line', { exact: false }).count() > 0, 'the diff shows the removed line too')
  await shot('02b-tool-cards')
})

await step('the session page follows the DSH conversation layout (column width, composer card, send button)', async () => {
  const box = await page.evaluate(() => {
    const tid = name => document.querySelector(`[data-testid="${name}"]`)
    const panel = tid('ext-panel')
    const input = tid('ext-input')
    const card = input.parentElement
    // The DSH theme token resolved the same way the composer card resolves it.
    const probe = document.createElement('div')
    probe.style.background = 'var(--dsw-specific-input-major)'
    panel.append(probe)
    const tokenBackground = getComputedStyle(probe).backgroundColor
    probe.remove()
    const send = tid('ext-send')
    const list = tid('ext-message').parentElement
    const cardStyle = getComputedStyle(card)
    return {
      panel: panel.getBoundingClientRect().toJSON(),
      panelWidth: panel.clientWidth,
      list: list.getBoundingClientRect().toJSON(),
      card: card.getBoundingClientRect().toJSON(),
      cardRadius: cardStyle.borderTopLeftRadius,
      cardBackground: cardStyle.backgroundColor,
      tokenBackground,
      inputBorder: getComputedStyle(input).borderTopWidth,
      send: { ...send.getBoundingClientRect().toJSON(), radius: parseFloat(getComputedStyle(send).borderTopLeftRadius) },
      schedule: tid('ext-schedule').getBoundingClientRect().toJSON(),
      composer: tid('ext-composer').getBoundingClientRect().toJSON(),
      title: getComputedStyle(tid('ext-title')).fontSize,
    }
  })
  const content = Math.min(box.panelWidth - 32, Math.max(680, Math.min(box.panelWidth * 0.64, 920)))
  console.log(`      panel ${Math.round(box.panelWidth)} px: column ${Math.round(box.list.width)} (DSH rule ${Math.round(content)}), card ${Math.round(box.card.width)}, send ${Math.round(box.send.width)} px`)
  assert(Math.abs(box.list.width - content) <= 1, `the message column is ${Math.round(box.list.width)} px, the DSH rule gives ${Math.round(content)} px`)
  const panelCentre = box.panel.left + box.panelWidth / 2
  assert(Math.abs(box.list.left + box.list.width / 2 - panelCentre) <= 1, 'the message column is centred')
  assert(Math.abs(box.card.width - (content + 32)) <= 1, `the composer card is ${Math.round(box.card.width)} px, DSH draws it 32 px wider than the column`)
  assert(box.cardRadius === '22px', `the composer card corner is ${box.cardRadius}, DSH uses 22px`)
  assert(box.cardBackground === box.tokenBackground, `the composer card is ${box.cardBackground}, the DSH input surface is ${box.tokenBackground}`)
  assert(box.inputBorder === '0px', 'the text area has no border of its own inside the card')
  assert(Math.round(box.send.width) === 34 && Math.round(box.send.height) === 34 && box.send.radius >= 17, 'the send button is the 34 px DSH circle')
  assert(box.schedule.top >= box.card.top && box.schedule.bottom <= box.card.bottom, 'send-later sits in the card toolbar')
  assert(box.title === '14px', `the title is ${box.title}, DSH uses 14px`)
  assert(Math.abs(box.composer.bottom - box.panel.bottom) <= 1, `the composer ends ${Math.round(box.panel.bottom - box.composer.bottom)} px above the panel bottom, so messages show through below it`)
})

const scrolledToEnd = () => panel().evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight <= 2)
const inView = locator => locator.evaluate((el) => {
  const box = el.getBoundingClientRect()
  const panelBox = el.closest('[data-testid="ext-panel"]').getBoundingClientRect()
  const composer = document.querySelector('[data-testid="ext-composer"]').getBoundingClientRect()
  return box.top >= panelBox.top && box.bottom <= composer.top + 1
})

await step('a session taller than the panel opens at its latest message, and a new reply stays in view', async () => {
  const long = manifest.at(-1)
  await row('long conversation').first().click()
  await page.locator('[data-testid="ext-summary"][data-status="ready"]').waitFor({ timeout: 10000 })
  await page.getByText('long reply 40', { exact: true }).waitFor({ timeout: 10000 })
  await page.waitForTimeout(500)
  assert(await panel().evaluate(el => el.scrollHeight > el.clientHeight * 2), 'the fixture should be taller than the panel')
  assert(await scrolledToEnd(), 'the panel should open scrolled to the bottom')
  assert(await inView(page.getByText('long reply 40', { exact: true })), 'the latest reply should be visible above the composer')
  const last = readFileSync(long.file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  appendFileSync(long.file, JSON.stringify({ ...last, uuid: 'ffffffff-0000-4000-8000-000000000002', parentUuid: last.uuid,
    message: { role: 'assistant', content: [{ type: 'text', text: 'late reply from a terminal' }] } }) + '\n')
  await page.locator('[data-testid="ext-reload"]').click({ timeout: 10000 })
  await page.getByText('late reply from a terminal').waitFor({ timeout: 10000 })
  await page.waitForTimeout(500)
  assert(await inView(page.getByText('late reply from a terminal')), 'a reply added at the bottom should be visible')
  await shot('02c-long-session')
  await row('list files').first().click()
  await page.locator('[data-testid="ext-title"]', { hasText: 'list files' }).waitFor({ timeout: 10000 })
})

await step('no stale banner before anything changes', async () => {
  await page.waitForTimeout(1500)
  assert(await page.locator('[data-testid="ext-stale"]').count() === 0, 'banner should be absent')
})

await step('gate 3: a write from elsewhere shows the "updated elsewhere" banner, reload picks it up', async () => {
  const lines = readFileSync(target.file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const last = lines.at(-1)
  const appended = { ...last, uuid: 'ffffffff-0000-4000-8000-000000000001', parentUuid: last.uuid, type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'written from a terminal' }] } }
  appendFileSync(target.file, JSON.stringify(appended) + '\n')
  await page.locator('[data-testid="ext-stale"]').waitFor({ timeout: 10000 })
  await shot('03-stale-banner')
  await page.locator('[data-testid="ext-reload"]').click()
  await page.locator('[data-testid="ext-summary"][data-status="ready"]').waitFor({ timeout: 10000 })
  await page.waitForFunction(n => Number(document.querySelector('[data-testid="ext-summary"]')?.getAttribute('data-count')) === n, target.visible + 1, { timeout: 10000 })
  assert(await page.getByText('written from a terminal').count() === 1, 'appended text should be rendered after reload')
  assert(await page.locator('[data-testid="ext-stale"]').count() === 0, 'banner should clear after reload')
})

await step('goal bar: shows condition, turns and last reason; disappears once the goal is met', async () => {
  const goalSession = manifest[2]
  await row('beta question').first().click()
  await page.locator('[data-testid="ext-goal"]').waitFor({ timeout: 10000 })
  assert((await page.locator('[data-testid="ext-goal-condition"]').innerText()) === 'ship the beta', 'goal condition')
  assert(await page.locator('[data-testid="ext-goal"]').getAttribute('data-iterations') === '2', 'goal iterations')
  assert((await page.locator('[data-testid="ext-goal-reason"]').innerText()) === 'tests are still failing', 'goal reason')
  await shot('04-goal-bar')
  const lines = readFileSync(goalSession.file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const last = lines.at(-1)
  appendFileSync(goalSession.file, JSON.stringify({ ...last, uuid: 'ffffffff-0000-4000-8000-000000000002', parentUuid: last.uuid,
    attachment: { type: 'goal_status', met: true, condition: 'ship the beta', iterations: 3, reason: 'done' } }) + '\n')
  await page.locator('[data-testid="ext-reload"]').click()
  await page.locator('[data-testid="ext-goal"]').waitFor({ state: 'detached', timeout: 10000 })
})

await step('switching rows swaps the transcript; the page stands in for the sidebar; leaving it clears the highlight', async () => {
  await row('beta question').first().click()
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-title"]')?.textContent === 'beta question', null, { timeout: 10000 })
  assert(await row('beta question').first().getAttribute('aria-selected') === 'true', 'second row should be selected')
  assert(await row('list files').first().getAttribute('aria-selected') === 'false', 'first row should be deselected')
  if (hub) {
    await page.getByRole('button', { name: 'New session' }).first().click()
    await page.locator('[data-testid="ext-panel"]').waitFor({ state: 'detached', timeout: 10000 })
    assert(await row('beta question').first().getAttribute('aria-selected') === 'false', 'row should no longer be selected after leaving the panel')
    return
  }
  const sidebarCollapsed = () => page.evaluate(() => document.querySelector('[data-sidebar-collapsed]') !== null)
  assert(await sidebarCollapsed(), 'the core sidebar should be collapsed while the page shows its own list')
  await page.locator('[data-testid="ext-list-back"]').click()
  await page.locator('[data-testid="ext-panel"]').waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('[data-sidebar-collapsed]') === null, null, { timeout: 5000 })
    .catch(() => { throw new Error('leaving the page should reopen the core sidebar') })
  await openPage()
  assert(await row('beta question').first().getAttribute('aria-selected') === 'false', 'row should no longer be selected after leaving the page')
})

const filesOnDisk = () => readdirSync(`${CONFIG_DIR}/projects`, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .flatMap(d => readdirSync(`${CONFIG_DIR}/projects/${d.name}`).filter(f => f.endsWith('.jsonl'))).length
await step('manage: fork copies the transcript, rename retitles it, delete removes the file', async () => {
  await row('gamma').first().click()
  await page.locator('[data-testid="ext-summary"][data-status="ready"]').waitFor({ timeout: 10000 })
  const before = filesOnDisk()
  const originalCount = await messageCount()
  await menuAction('ext-fork')
  await page.waitForFunction(() => document.querySelector('[data-testid="ext-title"]')?.textContent?.includes('fork'), null, { timeout: 10000 })
  await page.waitForFunction(n => Number(document.querySelector('[data-testid="ext-summary"]')?.getAttribute('data-count')) === n, originalCount, { timeout: 10000 })
  assert(filesOnDisk() === before + 1, `fork should add one file: ${before} -> ${filesOnDisk()}`)
  const forkTitle = await page.locator('[data-testid="ext-title"]').innerText()
  assert(forkTitle.includes('fork'), `forked session should be open, title was ${forkTitle}`)
  await menuAction('ext-rename')
  await page.locator('[data-testid="ext-rename-input"]').fill('renamed fork')
  await page.locator('[data-testid="ext-rename-save"]').click()
  await row('renamed fork').first().waitFor({ timeout: 10000 })
  await shot('05-manage')
  await menuAction('ext-delete')
  await page.locator('[data-testid="ext-delete-confirm"]').click()
  await page.waitForFunction(sel => ![...document.querySelectorAll(sel)].some(e => (e.textContent ?? '').includes('renamed fork')), rowSelector(), { timeout: 10000 })
  assert(filesOnDisk() === before, `delete should remove the fork file: ${before} vs ${filesOnDisk()}`)
})

await step(`changing the session limit to ${SMALL_LIMIT} shrinks the tree without a restart`, async () => {
  await writeLimit(SMALL_LIMIT)
  await openPage()
  await page.waitForFunction(([n, titles, sel]) => [...document.querySelectorAll(sel)].filter(e => titles.some(t => (e.textContent ?? '').includes(t))).length === n, [Number(SMALL_LIMIT), TITLES, rowSelector()], { timeout: 10000 })
})

await step(`session limit is restored to ${BIG_LIMIT}`, async () => {
  await writeLimit(BIG_LIMIT)
  await openPage()
  await page.waitForFunction(([n, titles, sel]) => [...document.querySelectorAll(sel)].filter(e => titles.some(t => (e.textContent ?? '').includes(t))).length === n, [manifest.length, TITLES, rowSelector()], { timeout: 10000 })
})

await step('Workspace browser row menu: pin, rename and archive act on a Claude row and survive a reload', async () => {
  const extRow = title => page.locator('[data-row-key^="session:ext:"]').filter({ hasText: title }).first()
  await openPage()
  const target = extRow('alpha one')
  if (!hub || await target.locator('button[aria-label]').count() === 0) {
    console.log('      skipped: rows are listed without the shipped row menu')
    return
  }
  const menu = async (row, item) => {
    await row.hover()
    await row.locator('button[aria-label]').first().click()
    const labels = await page.locator('[role="menu"] button').allTextContents()
    await page.locator('[role="menu"] button').filter({ hasText: item }).first().click()
    return labels.map(text => text.replace(/[⌥⌘⇧].*$/, '').trim())
  }
  const labels = await menu(target, /^Pin session/)
  assert(JSON.stringify(labels) === JSON.stringify(['Pin session', 'Rename', 'Archive session']), `menu items: ${labels.join(' | ')}`)
  await target.locator('[class*="pinIndicator"]').waitFor({ timeout: 10000 })
  await menu(target, /^Rename/)
  await page.locator('[role="dialog"] input').fill('alpha pinned')
  await page.locator('[role="dialog"] button').filter({ hasText: /^Rename$/ }).click()
  await extRow('alpha pinned').waitFor({ timeout: 10000 })
  await page.reload()
  await dismissOverlays()
  await openPage()
  const renamed = extRow('alpha pinned')
  await renamed.locator('[class*="pinIndicator"]').waitFor({ timeout: 15000 })
  await menu(renamed, /^Unpin session/)
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-row-key^="session:ext:"]')].some(e => e.textContent?.includes('alpha pinned') && e.querySelector('[class*="pinIndicator"]')), null, { timeout: 10000 })
  await menu(renamed, /^Rename/)
  await page.locator('[role="dialog"] input').fill('alpha one')
  await page.locator('[role="dialog"] button').filter({ hasText: /^Rename$/ }).click()
  await extRow('alpha one').waitFor({ timeout: 10000 })
  const archived = extRow('gamma')
  const key = await archived.getAttribute('data-row-key')
  await menu(archived, /^Archive session/)
  await page.waitForFunction(k => document.querySelector(`[data-row-key="${k}"]`) === null, key, { timeout: 3000 })
  const restore = await page.evaluate(async id => (await fetch('/api/agent-bridge/archive', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, archived: false }),
  })).status, key.slice('session:ext:'.length))
  assert(restore === 200, `restoring the archived row answered ${restore}`)
})

await step('no uncaught page errors', async () => {
  assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
})

await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length === 0 ? 0 : 1)
