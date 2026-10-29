#!/usr/bin/env node
// Stand-in for `codex app-server`: answers initialize and thread/turns/list, and refuses the
// whole-thread read so a test fails if the engine falls back to it. Requests are appended to
// the file named by FAKE_CODEX_LOG.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const turn = (n, extra = []) => ({
  id: `turn-${n}`,
  items: [
    { id: `u${n}`, type: 'userMessage', content: [{ type: 'text', text: `question ${n}` }] },
    ...extra,
    { id: `a${n}`, type: 'agentMessage', text: `answer ${n}` },
  ],
})
const huge = { id: 'cmd3', type: 'commandExecution', command: 'cat big.log', aggregatedOutput: 'y'.repeat(30 * 1024 * 1024), exitCode: 0 }

const reply = (id, result) => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) }
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ method: message.method, params: message.params })}\n`)
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize': return reply(message.id, { userAgent: 'fake' })
    case 'thread/turns/list': return reply(message.id, { data: [turn(3, [huge]), turn(2), turn(1)], nextCursor: 'older' })
    default: process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -1, message: `unexpected ${message.method}` } })}\n`)
  }
})
