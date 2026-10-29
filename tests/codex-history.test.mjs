import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexEngine } from '../src/codex.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url))

test('a Codex session opens from its latest turns only, quickly, with long tool output cut', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ee-codex-')), 'calls.jsonl')
  process.env.FAKE_CODEX_LOG = log
  const engine = new CodexEngine(FAKE)
  try {
    const started = Date.now()
    const page = await engine.readMessages('thread-1', 3)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5000, `reading took ${elapsed} ms`)
    const texts = page.messages.flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))
    assert.deepEqual(texts, ['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3'])
    assert.equal(page.earlierOmitted, true)
    const output = page.messages.flatMap(message => message.blocks).find(block => block.type === 'tool_result')
    assert.ok(output !== undefined && output.text.length <= 20_001, `tool output is ${output?.text.length} characters`)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const read = calls.find(call => call.method === 'thread/turns/list')
    assert.deepEqual(read.params, { threadId: 'thread-1', limit: 3, sortDirection: 'desc', itemsView: 'full' })
    assert.ok(!calls.some(call => call.method === 'thread/read' && call.params?.includeTurns === true), 'the whole thread must not be read')
  } finally {
    await engine.closeAll()
    delete process.env.FAKE_CODEX_LOG
  }
})
