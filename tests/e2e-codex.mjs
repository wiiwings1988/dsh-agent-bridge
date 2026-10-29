/**
 * Phase 4 acceptance for dsh-agent-bridge: real Codex turns through the dev instance (codex app-server).
 * Privacy rules: turns run only in /tmp/ee-codex-live, screenshots capture only the main panel, and every
 * thread this run created is deleted through the UI/API at the end. Costs real model calls.
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const EVIDENCE = fileURLToPath(new URL('../.evidence/phase4/', import.meta.url))
const LIVE_CWD = '/tmp/ee-codex-live'
rmSync(LIVE_CWD, { recursive: true, force: true })
mkdirSync(LIVE_CWD, { recursive: true })
mkdirSync(EVIDENCE, { recursive: true })

const token = /token=([A-Za-z0-9_-]+)/.exec(readFileSync(`${DEV_HOME}/logs/dev-web.log`, 'utf8'))?.[1]
if (token === undefined) throw new Error('no login token in the dev log; is the dev instance running?')

const results = []
const pageErrors = []
async function step(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    await panel().screenshot({ path: `${EVIDENCE}fail-${results.length}.png`, timeout: 5000 }).catch(() => {})
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 4).join('\n      ')}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => pageErrors.push(e.message))
const panel = () => page.locator('[data-testid="ext-panel"]')
const summary = () => page.locator('[data-testid="ext-summary"]')
const shot = name => panel().screenshot({ path: `${EVIDENCE}${name}.png` })
const TURN_MS = 180_000
const created = new Set()

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
  await page.waitForTimeout(500)
}
async function ensureTreeOpen() {
  if (await page.getByRole('treeitem').count() > 1) return
  await page.getByText('Ungrouped', { exact: true }).first().click().catch(() => {})
  await page.getByRole('treeitem').nth(1).waitFor({ timeout: 10000 })
}
const idle = () => page.locator('[data-testid="ext-summary"][data-running="false"]')
async function send(text) {
  await page.locator('[data-testid="ext-input"]').fill(text)
  await page.locator('[data-testid="ext-send"]').click()
  await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 20000 })
}
async function waitTurnEnd() {
  await idle().waitFor({ timeout: TURN_MS })
  await page.waitForTimeout(1500)
}
async function approveUntilIdle() {
  const deadline = Date.now() + TURN_MS
  while (Date.now() < deadline) {
    if (await idle().count() > 0) { await page.waitForTimeout(1500); return }
    const allow = page.locator('[data-testid="ext-allow"]')
    if (await allow.count() > 0) await allow.first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
  throw new Error('turn did not end in time')
}
const assistantText = () => page.locator('[data-testid="ext-message"][data-role="assistant"] [data-testid="ext-text"]').allInnerTexts()
const userPrompts = () => page.locator('[data-testid="ext-message"][data-role="user"] [data-testid="ext-text"]').count()
const sessionId = () => summary().getAttribute('data-session')
const listedIds = () => page.evaluate(async () => (await (await fetch('/api/agent-bridge/sessions', { credentials: 'same-origin' })).json()).sessions.map(s => s.id))
const writePrompt = file => `Create the file ${file} containing exactly the text OK using a shell command, then reply with the word done.`
const needsCard = () => page.locator('[data-testid="ext-permission"]').first().waitFor({ timeout: TURN_MS })

await page.goto(`${BASE}/?token=${token}`)
await dismissOverlays()

/** Run a session verb from the header's More actions menu (rename, fork, archive, delete). */
async function menuAction(id) {
  const item = page.locator(`[data-testid="${id}"]`)
  if (!await item.isVisible().catch(() => false)) await page.locator('[data-testid="ext-more"]').click()
  await item.click()
}

await step('new Codex session: the draft row exists and the first turn streams, ends, and lists the thread', async () => {
  await ensureTreeOpen()
  await page.getByRole('treeitem').filter({ hasText: 'New Codex session' }).first().click()
  await page.locator('[data-testid="ext-cwd"]').fill(LIVE_CWD)
  await send('Reply with exactly the single word PONG')
  await waitTurnEnd()
  const id = await sessionId()
  created.add(id)
  assert(id.startsWith('codex:') && id !== 'codex:new', `panel should show the created thread, got ${id}`)
  assert((await assistantText()).some(t => /PONG/.test(t)), `assistant should say PONG: ${JSON.stringify(await assistantText())}`)
  assert((await listedIds()).includes(id), 'the new thread should be in the session list')
  await shot('01-first-turn')
})

await step('continue the same thread (resume keeps context)', async () => {
  await send('Which single word did I ask you to reply with? Answer with just that word.')
  await waitTurnEnd()
  assert((await assistantText()).filter(t => /PONG/i.test(t)).length >= 2 && await userPrompts() === 2, 'second answer should repeat PONG and the thread should have 2 prompts')
})

await step('approval: a command asks; Allow runs it, Deny stops it', async () => {
  const approved = `${LIVE_CWD}/approved.txt`
  const denied = `${LIVE_CWD}/denied.txt`
  await send(writePrompt(approved))
  await needsCard()
  await shot('02-permission-card')
  assert(!existsSync(approved), 'file must not exist before approval')
  await page.locator('[data-testid="ext-allow"]').first().click()
  await approveUntilIdle()
  assert(existsSync(approved), 'approved command should have created the file')
  await send(writePrompt(denied))
  await needsCard()
  await page.locator('[data-testid="ext-deny"]').first().click()
  await approveUntilIdle().catch(() => {})
  await waitTurnEnd()
  assert(!existsSync(denied), 'denied command must not have created the file')
})

await step('"Allow for this session" is accepted and the command runs', async () => {
  await send(writePrompt(`${LIVE_CWD}/session-a.txt`))
  await needsCard()
  await page.locator('[data-testid="ext-always"]').first().click()
  await approveUntilIdle()
  assert(existsSync(`${LIVE_CWD}/session-a.txt`), 'first command should have run')
})

await step('goal: /goal from the bar runs until complete and the bar clears', async () => {
  const file = `${LIVE_CWD}/goal.txt`
  await page.locator('[data-testid="ext-goal-toggle"]').click()
  await page.locator('[data-testid="ext-goal-input"]').fill(`the file ${file} exists and contains the word HELLO`)
  await page.locator('[data-testid="ext-goal-set"]').click()
  await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 30000 })
  await approveUntilIdle()
  assert(existsSync(file) && /HELLO/.test(readFileSync(file, 'utf8')), 'goal should have been achieved')
  await page.locator('[data-testid="ext-goal-input"]').waitFor({ timeout: 15000 })
  assert(await page.locator('[data-testid="ext-goal"]').count() === 0, 'goal bar should be gone once the goal is complete')
  await shot('03-goal-complete')
})

await step('interrupt: Stop ends a running turn', async () => {
  await send('Write a very long essay about the history of numbers, at least 3000 words, no tools.')
  await page.locator('[data-testid="ext-partial"]').waitFor({ timeout: 60000 })
  await page.locator('[data-testid="ext-stop"]').click()
  await idle().waitFor({ timeout: 45000 })
})

await step('manage: fork copies the thread, rename retitles it, delete removes it', async () => {
  const sourceId = await sessionId()
  const count = Number(await summary().getAttribute('data-count'))
  await menuAction('ext-fork')
  await page.waitForFunction(old => document.querySelector('[data-testid="ext-summary"]')?.getAttribute('data-session') !== old, sourceId, { timeout: 15000 })
  const forkId = await sessionId()
  created.add(forkId)
  assert(forkId.startsWith('codex:') && forkId !== sourceId, 'fork should open a new Codex thread')
  // thread/list does not return a fork before its first own turn, so the row is the browser's own until then.
  await page.waitForFunction(n => Number(document.querySelector('[data-testid="ext-summary"]')?.getAttribute('data-count')) >= n, Math.max(1, count - 1), { timeout: 15000 })
  await menuAction('ext-rename')
  await page.locator('[data-testid="ext-rename-input"]').fill('codex renamed fork')
  await page.locator('[data-testid="ext-rename-save"]').click()
  await page.getByRole('treeitem').filter({ hasText: 'codex renamed fork' }).first().waitFor({ timeout: 15000 })
  await menuAction('ext-delete')
  await page.locator('[data-testid="ext-delete-confirm"]').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[role=treeitem]')].some(e => (e.textContent ?? '').includes('codex renamed fork')), null, { timeout: 15000 })
  assert(!(await listedIds()).includes(forkId), 'deleted fork should be gone from the list')
  created.delete(forkId)
})

await step('cleanup: test threads deleted, temp folder removed', async () => {
  for (const id of [...created].reverse()) {
    await ensureTreeOpen()
    const response = await page.evaluate(async (target) => {
      const result = await fetch('/api/agent-bridge/manage', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: target, action: 'delete' }),
      })
      return `${result.status} ${await result.text()}`
    }, id)
    assert(response.startsWith('200'), `delete ${id} returned ${response}`)
  }
  const left = await listedIds()
  assert([...created].every(id => !left.includes(id)), 'no test thread should remain')
  rmSync(LIVE_CWD, { recursive: true, force: true })
})

await step('no uncaught page errors', async () => {
  assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
})

await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length === 0 ? 0 : 1)
