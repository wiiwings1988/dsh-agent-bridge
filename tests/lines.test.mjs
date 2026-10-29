import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineSplitter } from '../src/lines.ts'

test('a 30 MB line arriving in 64 KB chunks is split quickly and intact', () => {
  const line = JSON.stringify({ id: 1, result: { text: 'x'.repeat(30 * 1024 * 1024) } })
  const stream = `${line}\n{"id":2}\n`
  const splitter = new LineSplitter()
  const lines = []
  const started = Date.now()
  for (let at = 0; at < stream.length; at += 64 * 1024) lines.push(...splitter.push(stream.slice(at, at + 64 * 1024)))
  const elapsed = Date.now() - started
  assert.equal(lines.length, 2)
  assert.equal(lines[0], line)
  assert.equal(lines[1], '{"id":2}')
  assert.ok(elapsed < 2000, `splitting took ${elapsed} ms`)
})

test('several lines in one chunk, a line split across chunks, and reset', () => {
  const splitter = new LineSplitter()
  assert.deepEqual(splitter.push('a\nb\nc'), ['a', 'b'])
  assert.deepEqual(splitter.push('d\n'), ['cd'])
  assert.deepEqual(splitter.push('\n'), [''])
  splitter.push('half')
  splitter.reset()
  assert.deepEqual(splitter.push('new\n'), ['new'])
})
