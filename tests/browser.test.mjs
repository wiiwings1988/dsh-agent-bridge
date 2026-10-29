import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { probeInfo } from '../src/run.ts'

const base = {
  cwd: homedir(), text: '', executable: process.env.EE_REAL_CLAUDE ?? 'claude',
  permissionMode: 'default', allowedTools: [], computerUse: false, peekabooCommand: 'peekaboo', memory: '',
}

test('browser use: the Playwright MCP server starts with the turn and offers its tools; off means absent', async () => {
  const on = await probeInfo({ ...base, browserUse: true })
  const server = on.mcp.find(item => item.name === 'playwright-dsh')
  assert.ok(server, `server missing: ${JSON.stringify(on.mcp)}`)
  assert.equal(server.status, 'connected', JSON.stringify(server))
  assert.ok((server.tools ?? 0) >= 10, `expected the browser tools, got ${server.tools}`)
  const off = await probeInfo({ ...base, browserUse: false })
  assert.equal(off.mcp.some(item => item.name === 'playwright-dsh'), false)
})
