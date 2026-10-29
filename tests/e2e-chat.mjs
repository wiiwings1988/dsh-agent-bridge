/**
 * Phase 2 acceptance for dsh-agent-bridge: real Claude turns through the dev instance.
 * The dev instance must run with the real Claude config directory (no CLAUDE_CONFIG_DIR), because the
 * login credentials are keyed by that directory. Privacy rules: turns run only in the dedicated folder
 * /tmp/ee-live, screenshots capture only the main panel, and every session this run created is deleted at
 * the end (the folder holds nothing else). Costs real model calls (~10 turns).
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const EVIDENCE = fileURLToPath(new URL('../.evidence/phase2/', import.meta.url))
const LIVE_CWD = '/tmp/ee-live'
mkdirSync(EVIDENCE, { recursive: true })
mkdirSync(LIVE_CWD, { recursive: true })
const PROJECT_DIR = `${homedir()}/.claude/projects/${realpathSync(LIVE_CWD).replace(/[^a-zA-Z0-9]/g, '-')}`

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
const card = () => page.locator('[data-testid="ext-settings-card"]')
const TURN_MS = 150_000
const WRITE_FILE = `${LIVE_CWD}/approved.txt`
const DENIED_FILE = `${LIVE_CWD}/denied.txt`
const ALWAYS_FILE = `${LIVE_CWD}/always.txt`
const AUTO_FILE = `${LIVE_CWD}/auto.txt`
const writePrompt = file => `Use the Write tool to create the file ${file} containing the text OK. Then reply with the word done.`
async function ensureTreeOpen() {
  const draft = page.getByRole('treeitem').filter({ hasText: 'New Claude session' })
  await page.waitForTimeout(1500)
  if (await draft.count() > 0) return
  await page.getByText('Ungrouped', { exact: true }).first().click().catch(() => {})
  await draft.first().waitFor({ timeout: 10000 })
}
const userPrompts = () => page.locator('[data-testid="ext-message"][data-role="user"] [data-testid="ext-text"]').count()

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
async function openSettings() {
  if (await card().isVisible().catch(() => false)) return
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const tab = page.getByText(/plugin/i).first()
  if (await tab.isVisible().catch(() => false)) await tab.click()
  await card().waitFor({ timeout: 10000 })
}
async function closeSettings() {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  if (await card().isVisible().catch(() => false)) await page.getByRole('button', { name: /close/i }).first().click().catch(() => {})
  await card().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
}
async function setAllowedTools(value) {
  await openSettings()
  const input = page.locator('[data-testid="ext-allowed"]')
  if ((await input.inputValue()) !== value) {
    await input.fill(value)
    await page.locator('[data-testid="ext-save-allowed"]').click()
    await page.locator('[data-testid="ext-saved"]').waitFor({ timeout: 10000 })
  }
  await closeSettings()
}
const idle = () => page.locator('[data-testid="ext-summary"][data-running="false"]')
async function send(text) {
  await page.locator('[data-testid="ext-input"]').fill(text)
  await page.locator('[data-testid="ext-send"]').click()
  await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 15000 })
}
async function waitTurnEnd() {
  await idle().waitFor({ timeout: TURN_MS })
  await page.waitForTimeout(1500)
}
/** Wait for the turn to end, approving any permission card that appears on the way (a goal may run several tools). */
async function approveUntilIdle(timeoutMs = TURN_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await idle().count() > 0) { await page.waitForTimeout(1500); return }
    const allow = page.locator('[data-testid="ext-allow"]')
    if (await allow.count() > 0) await allow.first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
  throw new Error('turn did not end in time')
}
const assistantText = () => page.locator('[data-testid="ext-message"][data-role="assistant"] [data-testid="ext-text"]').allInnerTexts()
const messageCount = async () => Number(await summary().getAttribute('data-count'))

await page.goto(`${BASE}/?token=${token}`)
await dismissOverlays()
await step('baseline: allow list is empty', async () => { await setAllowedTools('') })

let sessionTitle = ''
await step('new session: draft row opens an empty composer', async () => {
  await ensureTreeOpen()
  await page.getByRole('treeitem').filter({ hasText: 'New Claude session' }).first().click()
  await panel().waitFor({ timeout: 10000 })
  await page.locator('[data-testid="ext-cwd"]').fill(LIVE_CWD)
  assert(await messageCount() === 0, 'draft should show no messages')
})

await step('send streams a reply, writes the session file, and lists the session', async () => {
  sessionTitle = 'Reply with exactly the single word PONG'
  await send(sessionTitle)
  let sawPartial = false
  const watcher = (async () => {
    for (let i = 0; i < 300 && !sawPartial; i++) {
      sawPartial = await page.locator('[data-testid="ext-partial"]').count() > 0
      await page.waitForTimeout(100)
    }
  })()
  await waitTurnEnd()
  await watcher
  const texts = await assistantText()
  console.log(`      assistant: ${JSON.stringify(texts.at(-1))} partial-seen=${sawPartial}`)
  assert(texts.some(t => /PONG/.test(t)), 'assistant reply should contain PONG')
  const conversationFiles = () => readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl') && readFileSync(`${PROJECT_DIR}/${f}`, 'utf8').includes('"type":"assistant"'))
  const describeFiles = () => readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl')).map((f) => {
    const types = {}
    for (const line of readFileSync(`${PROJECT_DIR}/${f}`, 'utf8').trim().split('\n')) { const t = JSON.parse(line).type; types[t] = (types[t] ?? 0) + 1 }
    return `${f.slice(0, 8)}${JSON.stringify(types)}`
  }).join(' | ')
  assert(existsSync(PROJECT_DIR) && conversationFiles().length === 1, `exactly one session file should exist for the live folder: ${describeFiles()}`)
  assert(await userPrompts() === 1, `expected 1 user prompt, got ${await userPrompts()}`)
  assert(await page.locator('[data-testid="ext-title"]').innerText() !== '+ New Claude session', 'panel should now show the created session')
  assert(await page.getByRole('treeitem').count() >= 3, 'new session should be in the tree')
  await shot('01-first-turn')
})

await step('continue the same session (resume keeps context)', async () => {
  await send('Which single word did I ask you to reply with? Answer with just that word.')
  await waitTurnEnd()
  assert((await assistantText()).some(t => /PONG/i.test(t)) && await userPrompts() === 2, `expected 2 user prompts and PONG, got ${await userPrompts()}`)
  assert(readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl') && readFileSync(`${PROJECT_DIR}/${f}`, 'utf8').includes('"type":"assistant"')).length === 1, 'resume must not create a second conversation file')
})

await step('approval: a Write call shows a card; Allow runs it', async () => {
  await send(writePrompt(WRITE_FILE))
  await page.locator('[data-testid="ext-permission"][data-tool="Write"]').waitFor({ timeout: TURN_MS })
  await shot('02-permission-card')
  assert(!existsSync(WRITE_FILE), 'file must not exist before approval')
  await page.locator('[data-testid="ext-allow"]').click()
  await waitTurnEnd()
  assert(existsSync(WRITE_FILE) && readFileSync(WRITE_FILE, 'utf8').trim() === 'OK', 'approved Write should have created the file')
})

await step('approval: Deny keeps the file from being written', async () => {
  await send(writePrompt(DENIED_FILE))
  await page.locator('[data-testid="ext-permission"][data-tool="Write"]').waitFor({ timeout: TURN_MS })
  await page.locator('[data-testid="ext-deny"]').click()
  await waitTurnEnd()
  assert(!existsSync(DENIED_FILE), 'denied Write must not have created the file')
})

await step('question card: AskUserQuestion is answered from the UI', async () => {
  await send('Use the AskUserQuestion tool to ask me which color I prefer, with options red and blue. After I answer, reply with only the chosen color word.')
  await page.locator('[data-testid="ext-question"]').waitFor({ timeout: TURN_MS })
  await shot('03-question-card')
  await page.locator('[data-testid="ext-option"]').nth(1).check()
  const chosen = (await page.locator('[data-testid="ext-question"] label').nth(1).innerText()).toLowerCase()
  await page.locator('[data-testid="ext-answer"]').click()
  await waitTurnEnd()
  const last = (await assistantText()).at(-1)?.toLowerCase() ?? ''
  const color = /red|blue/.exec(chosen)?.[0]
  console.log(`      chose "${color}", assistant said ${JSON.stringify(last)}`)
  assert(color !== undefined && last.includes(color), 'assistant should reflect the chosen option')
})

await step('always allow: one click, later Write calls need no card', async () => {
  await send(writePrompt(ALWAYS_FILE))
  await page.locator('[data-testid="ext-permission"][data-tool="Write"]').waitFor({ timeout: TURN_MS })
  await page.locator('[data-testid="ext-always"]').click()
  await waitTurnEnd()
  await openSettings()
  assert((await page.locator('[data-testid="ext-allowed"]').inputValue()).includes('Write'), 'allow list should now contain Write')
  await closeSettings()
  await send(writePrompt(AUTO_FILE))
  const sawCard = await page.locator('[data-testid="ext-permission"]').waitFor({ timeout: 25000 }).then(() => true, () => false)
  await waitTurnEnd()
  assert(!sawCard, 'no approval card should appear once Write is always allowed')
  assert(existsSync(AUTO_FILE), 'the Write should have run without asking')
})

const GOAL_FILE = `${LIVE_CWD}/goal.txt`
await step('goal: /goal set from the bar runs until met, then the bar clears itself', async () => {
  await page.locator('[data-testid="ext-goal-toggle"]').click()
  await page.locator('[data-testid="ext-goal-input"]').fill(`the file ${GOAL_FILE} exists and contains the word HELLO`)
  await page.locator('[data-testid="ext-goal-set"]').click()
  await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 15000 })
  await approveUntilIdle()
  assert(existsSync(GOAL_FILE) && /HELLO/.test(readFileSync(GOAL_FILE, 'utf8')), 'the goal should have been achieved')
  await page.locator('[data-testid="ext-goal-input"]').waitFor({ timeout: 10000 })
  assert(await page.locator('[data-testid="ext-goal"]').count() === 0, 'goal bar should be gone after the goal is met')
  await shot('05-goal-met')
})

await step('goal: an unmet goal shows the bar and Clear removes it', async () => {
  await page.locator('[data-testid="ext-goal-input"]').fill('the user has typed the word BANANA in the chat')
  await page.locator('[data-testid="ext-goal-set"]').click()
  await page.locator('[data-testid="ext-goal"]').waitFor({ timeout: TURN_MS })
  await shot('06-goal-active')
  if (await page.locator('[data-testid="ext-stop"]').count() > 0) await page.locator('[data-testid="ext-stop"]').click()
  await idle().waitFor({ timeout: 60000 })
  await page.locator('[data-testid="ext-goal-clear"]').click()
  await page.locator('[data-testid="ext-goal"]').waitFor({ state: 'detached', timeout: TURN_MS })
})

await step('interrupt: Stop ends a running turn', async () => {
  await send('Count from 1 to 300, one number per line, no other text.')
  await page.locator('[data-testid="ext-partial"], [data-testid="ext-permission"]').first().waitFor({ timeout: 60000 })
  await page.locator('[data-testid="ext-stop"]').click()
  await idle().waitFor({ timeout: 30000 })
  await shot('04-interrupted')
})

await step('reload mid-turn: the page re-attaches to the running turn and it finishes', async () => {
  await send('Write a very long essay about the history of numbers, at least 3000 words, no tools.')
  await page.locator('[data-testid="ext-partial"]').waitFor({ timeout: 60000 })
  const runningTitle = (await page.locator('[data-testid="ext-title"]').innerText()).trim()
  await page.reload()
  await dismissOverlays()
  await ensureTreeOpen()
  await page.getByRole('treeitem').filter({ hasText: runningTitle.slice(0, 30) }).first().click()
  await panel().waitFor({ timeout: 10000 })
  const attached = await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 8000 }).then(() => true, () => false)
  console.log(`      re-attached while running: ${attached}`)
  const diag = await summary().evaluate(e => `status=${e.dataset.status} count=${e.dataset.count} running=${e.dataset.running}`)
  const rowsSeen = await page.getByRole('treeitem').count()
  assert(attached, `after reload the panel should show the turn as running (${diag}, treeitems=${rowsSeen}, title=${(await page.locator('[data-testid="ext-title"]').innerText()).slice(0, 12)})`)
  await page.locator('[data-testid="ext-stop"]').click()
  await waitTurnEnd()
})

await step('screen control: the settings card shows permissions, a connected server, no analyze/agent tools', async () => {
  await openSettings()
  const server = page.locator('[data-testid="ext-screen-server"]')
  await server.waitFor({ timeout: 60000 })
  const tools = (await server.getAttribute('data-tools') ?? '').split(',')
  console.log(`      server=${await server.getAttribute('data-server')} tools=${tools.length}`)
  assert(await server.getAttribute('data-server') === 'connected', 'screen MCP server should be connected')
  assert(['see', 'click', 'type', 'image'].every(tool => tools.includes(tool)), `expected core tools, got ${tools.join(',')}`)
  assert(!tools.includes('analyze') && !tools.includes('agent'), 'analyze and agent must be disabled (they send screenshots to external models)')
  assert((await page.locator('[data-testid="ext-screen-status"]').innerText()).includes('Granted'), 'permission status should list Granted')
  await closeSettings()
})

await step('screen control: a read-only capture runs without asking and its image renders', async () => {
  await send('Use the mcp__peekaboo-dsh__see tool to capture the main screen once. Then reply with the single word captured.')
  const deadline = Date.now() + TURN_MS
  let asked = ''
  while (Date.now() < deadline && await idle().count() === 0) {
    const card = page.locator('[data-testid="ext-permission"]')
    if (await card.count() > 0) { asked = await card.first().getAttribute('data-tool') ?? ''; break }
    await page.waitForTimeout(400)
  }
  assert(asked === '', `read-only capture should not ask, but asked for ${asked}`)
  await page.waitForTimeout(1500)
  const images = page.locator('[data-testid="ext-image"]')
  await images.first().waitFor({ timeout: 20000 }).catch(() => {})
  await page.locator('[data-testid="ext-tool-use"]').last().click()
  const toolNames = await page.locator('[data-testid="ext-tool-use"]').evaluateAll(els => els.slice(-3).map(e => (e.textContent ?? '').slice(0, 60)))
  const resultLens = await page.locator('[data-testid="ext-tool-result"]').evaluateAll(els => els.slice(-3).map(e => (e.textContent ?? '').length))
  console.log(`      images rendered: ${await images.count()} last tools: ${JSON.stringify(toolNames)} result lengths: ${JSON.stringify(resultLens)}`)
  const resultBlock = page.locator('[data-testid="ext-tool-result"]')
  const lastResult = await resultBlock.count() === 0 ? '' : (await resultBlock.last().innerText()).slice(0, 300)
  if (await images.count() === 0 && /GUI session is locked/.test(lastResult)) {
    console.log('      SKIPPED image check: the macOS session is locked, so no capture is possible (unlock the screen and rerun)')
    return
  }
  assert(await images.count() > 0, `the screenshot should be rendered in the transcript; last tool result: ${lastResult}`)
  assert(await images.first().evaluate(img => img.naturalWidth > 0), 'the image should decode')
  await images.first().click()
  await page.locator('[data-testid="ext-zoom"]').waitFor({ timeout: 5000 })
  await page.locator('[data-testid="ext-zoom"]').click()
})

await step('screen control: a click asks for approval and Deny stops it', async () => {
  await send('Use the mcp__peekaboo-dsh__click tool to click at screen coordinates x=3, y=3.')
  const card = page.locator('[data-testid="ext-permission"]')
  await card.first().waitFor({ timeout: TURN_MS })
  const tool = await card.first().getAttribute('data-tool')
  assert(tool === 'mcp__peekaboo-dsh__click', `expected a click approval, got ${tool}`)
  await page.locator('[data-testid="ext-deny"]').click()
  await waitTurnEnd()
})

const MEMORY_FILE = `${DEV_HOME}/memory-fixture/MEMORY.md`
const CODE_WORD = `EEMEM${Date.now().toString(36).toUpperCase()}`
await step('memory bridge: a dsh memory file reaches a new Claude session, and is off when the setting is empty', async () => {
  mkdirSync(`${DEV_HOME}/memory-fixture`, { recursive: true })
  writeFileSync(MEMORY_FILE, `[2026-10-17] The shared code word is ${CODE_WORD}.\n`)
  const setMemory = async (value) => {
    await openSettings()
    if (await page.locator('[data-testid="ext-memory"]').inputValue() !== value) {
      await page.locator('[data-testid="ext-memory"]').fill(value)
      await page.locator('[data-testid="ext-save-memory"]').click()
      await page.locator('[data-testid="ext-saved"]').waitFor({ timeout: 10000 })
    }
    await closeSettings()
  }
  const newSessionAsking = async () => {
    await ensureTreeOpen()
    await page.getByRole('treeitem').filter({ hasText: 'New Claude session' }).first().click()
    await page.locator('[data-testid="ext-cwd"]').fill(LIVE_CWD)
    await send('Do not use any tools. Look only at the "Memory shared from dsh" section of your system prompt: what is the shared code word there? Reply with only the word, or UNKNOWN if that section does not exist or has none.')
    await waitTurnEnd()
    return (await assistantText()).join(' ')
  }
  await setMemory(MEMORY_FILE)
  const withMemory = await newSessionAsking()
  await setMemory('')
  const without = await newSessionAsking()
  console.log(`      on: ${withMemory.includes(CODE_WORD)} off: ${!without.includes(CODE_WORD)}`)
  assert(withMemory.includes(CODE_WORD), 'the code word from the memory file should reach the model')
  assert(!without.includes(CODE_WORD), 'with the bridge off the code word must not appear')
  rmSync(`${DEV_HOME}/memory-fixture`, { recursive: true, force: true })
})

await step('cleanup: allow list restored, test sessions deleted', async () => {
  await setAllowedTools('')
  rmSync(PROJECT_DIR, { recursive: true, force: true })
  rmSync(LIVE_CWD, { recursive: true, force: true })
  assert(!existsSync(PROJECT_DIR) && !existsSync(LIVE_CWD), 'live folders should be gone')
})

await step('no uncaught page errors', async () => {
  assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
})

await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
process.exit(failed.length === 0 ? 0 : 1)
