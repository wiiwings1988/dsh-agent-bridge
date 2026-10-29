import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

/** Talks JSON-RPC to the same Playwright MCP command the plugin hands to Claude and loads a real page. */
test('browser use: the MCP server opens a local page and the snapshot contains its text', async () => {
  const page = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>wb</title><h1>hello-from-test-page</h1><button>press-me</button>') })
  await new Promise(resolve => page.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${page.address().port}/`
  const child = spawn('npx', ['-y', '@playwright/mcp@0.0.83', '--isolated', '--headless'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      try { const message = JSON.parse(line); pending.get(message.id)?.(message) } catch { /* not a JSON line */ }
    }
  })
  let next = 1
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 90_000)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const navigated = await rpc('tools/call', { name: 'browser_navigate', arguments: { url } })
    assert.ok(!navigated.error, JSON.stringify(navigated.error))
    const snapshot = await rpc('tools/call', { name: 'browser_snapshot', arguments: {} })
    const text = JSON.stringify(snapshot.result)
    assert.match(text, /hello-from-test-page/)
    assert.match(text, /press-me/)
  } finally {
    child.kill()
    page.close()
  }
})
