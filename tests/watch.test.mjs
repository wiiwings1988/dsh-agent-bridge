import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchStream } from '../src/watch.ts'

async function readUntil(reader, pattern, ms) {
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  while (!pattern.test(text)) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`timed out waiting for ${pattern}; got ${JSON.stringify(text)}`)
    const chunk = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), left))])
    if (chunk.timeout === true || chunk.done === true) continue
    text += decoder.decode(chunk.value)
  }
  return text
}

test('a Codex session whose rollout was compressed away is watched, and its rewrite is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ee-watch-'))
  const file = join(dir, 'rollout.jsonl')
  writeFileSync(`${file}.zst`, 'compressed')
  const abort = new AbortController()
  const response = watchStream(file, 50, abort.signal)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  await readUntil(reader, /: watching/, 2000)
  writeFileSync(file, '{"type":"turn"}\n')
  const text = await readUntil(reader, /"changed":true/, 3000)
  assert.match(text, /"size":16/)
  abort.abort()
  await reader.cancel()
})

test('appending to an existing session file is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ee-watch-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, 'a\n')
  const abort = new AbortController()
  const reader = watchStream(file, 50, abort.signal).body.getReader()
  await readUntil(reader, /: watching/, 2000)
  writeFileSync(file, 'a\nb\n')
  assert.match(await readUntil(reader, /"changed":true/, 3000), /"size":4/)
  abort.abort()
  await reader.cancel()
})
