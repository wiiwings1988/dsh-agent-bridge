/**
 * Screen-control acceptance for dsh-agent-bridge with a real Claude turn and the real Peekaboo.
 * Privacy: the target is a throwaway Chrome window (own profile, local page) and the prompts name its
 * process, so the model is only asked to capture that window, never the desktop. The page is one big
 * button that reports a click to a local sink; the sink receiving the click is the gate for "Claude clicked
 * the window through Peekaboo after the user approved it". Needs the dev instance on the real Claude
 * config (see e2e-chat.mjs) and an unlocked screen. Sessions it creates are deleted at the end.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url))
const { chromium } = require('playwright')

const DEV_HOME = process.env.DEV_HOME ?? `${homedir()}/.local/share/dsh-dev-home`
const BASE = process.env.DEV_BASE ?? 'http://127.0.0.1:16777'
const EVIDENCE = fileURLToPath(new URL('../.evidence/screen/', import.meta.url))
const LIVE_CWD = '/tmp/ee-live'
const SINK_PORT = 16791
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE_DIR = '/tmp/ee-screen-chrome'
mkdirSync(EVIDENCE, { recursive: true })
mkdirSync(LIVE_CWD, { recursive: true })
const PROJECT_DIR = `${homedir()}/.claude/projects/${realpathSync(LIVE_CWD).replace(/[^a-zA-Z0-9]/g, '-')}`

const token = [...readFileSync(`${DEV_HOME}/logs/dev-web.log`, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
if (token === undefined) throw new Error('no login token in the dev log; is the dev instance running?')

const clicks = []
const sink = createServer((request, response) => {
  if (request.url === '/clicked') {
    clicks.push(Date.now())
    response.writeHead(204).end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><title>Peekaboo target</title><body style="margin:0">'
    + '<button id="b" style="width:100vw;height:100vh;font-size:40px" onclick="fetch(\'/clicked\');this.textContent=\'CLICKED\'">CLICK ME</button>')
})
await new Promise(resolve => sink.listen(SINK_PORT, '127.0.0.1', resolve))

rmSync(PROFILE_DIR, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  // Without this Chrome exposes page content to the accessibility API only when it detects an assistive
  // client, so Peekaboo's capture sometimes lists no element id for the page button and Claude cannot click it.
  `--user-data-dir=${PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility',
  '--window-position=140,140', '--window-size=640,420', '--new-window', `http://127.0.0.1:${SINK_PORT}/`,
], { stdio: 'ignore' })
await new Promise(resolve => setTimeout(resolve, 4000))

const results = []
async function step(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    await panel().screenshot({ path: `${EVIDENCE}fail-${results.length}.png`, timeout: 5000 }).catch(() => {})
    console.log(`      running=${await page.locator('[data-testid="ext-summary"]').getAttribute('data-running').catch(() => '?')} permissionCards=${await page.locator('[data-testid="ext-permission"]').count()}`)
    console.log(`FAIL  ${name}\n      ${String(error.message ?? error).split('\n').slice(0, 4).join('\n      ')}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const panel = () => page.locator('[data-testid="ext-panel"]')
const idle = () => page.locator('[data-testid="ext-summary"][data-running="false"]')
const TURN_MS = 150_000

try {
  await page.goto(`${BASE}/?token=${token}`)
  for (const name of [/^Continue$/, /^Configure later$/]) {
    const button = page.locator('button', { hasText: name })
    try { await button.waitFor({ state: 'visible', timeout: 6000 }); await button.click() } catch { /* not shown */ }
  }
  await page.waitForTimeout(1500)
  const draft = page.getByRole('treeitem').filter({ hasText: 'New Claude session' })
  if (await draft.count() === 0) await page.getByText('Ungrouped', { exact: true }).first().click().catch(() => {})
  await draft.first().waitFor({ timeout: 10000 })
  await draft.first().click()
  await panel().waitFor({ timeout: 10000 })
  await page.locator('[data-testid="ext-cwd"]').fill(LIVE_CWD)

  await step('target window: a throwaway Chrome window shows the local page', async () => {
    assert(chrome.pid !== undefined && chrome.exitCode === null, 'Chrome did not start')
    const html = await (await fetch(`http://127.0.0.1:${SINK_PORT}/`)).text()
    assert(html.includes('CLICK ME'), 'sink page not served')
  })

  const target = `PID:${chrome.pid}`
  await step('screen control: Claude captures only the target window and the image renders', async () => {
    await page.locator('[data-testid="ext-input"]').fill(
      `Use the mcp__peekaboo-dsh__see tool exactly once with app_target "${target}" to capture only that application window. `
      + 'Do not capture any screen or other application. Then reply with the single word captured.')
    await page.locator('[data-testid="ext-send"]').click()
    await page.locator('[data-testid="ext-summary"][data-running="true"]').waitFor({ timeout: 15000 })
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
    await images.first().waitFor({ timeout: 20000 })
    assert(await images.first().evaluate(img => img.naturalWidth > 0), 'the image should decode')
    const { width, height } = await images.first().evaluate(img => ({ width: img.naturalWidth, height: img.naturalHeight }))
    console.log(`      captured image ${width}x${height} (desktop is much larger than a 640x420 window)`)
    assert(width < 1700 && height < 1100, 'image looks like a whole screen, not one window')
    await panel().screenshot({ path: `${EVIDENCE}capture.png` })
  })

  await step('screen control: Claude clicks the window after approval, and the page receives the click', async () => {
    assert(clicks.length === 0, 'no click should have happened yet')
    await page.locator('[data-testid="ext-input"]').fill(
      `In this one turn: first call mcp__peekaboo-dsh__see with app_target "${target}" (a fresh capture; snapshots do not survive between turns), `
      + 'then call mcp__peekaboo-dsh__click once on the large CLICK ME button using the element id from that capture. Then reply with the word clicked.')
    await page.locator('[data-testid="ext-send"]').click()
    const card = page.locator('[data-testid="ext-permission"]')
    await card.first().waitFor({ timeout: TURN_MS })
    assert(await card.first().getAttribute('data-tool') === 'mcp__peekaboo-dsh__click', 'expected a click approval')
    assert(clicks.length === 0, 'the click must not happen before approval')
    await panel().screenshot({ path: `${EVIDENCE}approval.png` })
    await page.locator('[data-testid="ext-allow"]').click()
    const deadline = Date.now() + TURN_MS
    while (Date.now() < deadline && await idle().count() === 0) {
      const again = page.locator('[data-testid="ext-allow"]')
      if (await again.count() > 0) await again.first().click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(1500)
    assert(clicks.length >= 1, 'the page never received the click')
    console.log(`      clicks received: ${clicks.length}`)
  })
} finally {
  await browser.close()
  chrome.kill()
  sink.close()
  if (results.some(r => !r.ok)) {
    for (const file of readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl'))) {
      for (const line of readFileSync(`${PROJECT_DIR}/${file}`, 'utf8').split('\n').filter(Boolean)) {
        const content = JSON.parse(line).message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type === 'text') console.log(`      TEXT ${block.text.slice(0, 300)}`)
          if (block.type === 'tool_use') console.log(`      USE ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`)
          if (block.type === 'tool_result') console.log(`      RESULT ${JSON.stringify(block.content).slice(0, 300)}`)
        }
      }
    }
  }
  for (const file of readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl'))) rmSync(`${PROJECT_DIR}/${file}`, { force: true })
  await new Promise(resolve => setTimeout(resolve, 2000))
  rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} steps passed`)
process.exit(failed === 0 ? 0 : 1)
