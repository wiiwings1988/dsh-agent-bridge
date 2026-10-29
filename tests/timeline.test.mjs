/** Unit gate for buildTimeline. Run: ../../../node_modules/.bin/tsx --test tests/timeline.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/client/timeline.ts'

const use = (id, name = 'Bash') => ({ type: 'tool_use', name, input: '{}', id, args: {} })
const result = (forId, text = 'out') => ({ type: 'tool_result', text, forId })

test('a result joins its call and its result-only message disappears', () => {
  const timeline = buildTimeline([
    { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
    { id: 'a1', role: 'assistant', blocks: [use('t1')] },
    { id: 'u2', role: 'user', blocks: [result('t1', 'file-a')] },
    { id: 'a2', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
  ])
  assert.deepEqual(timeline.map(m => m.id), ['u1', 'a1', 'a2'])
  const tool = timeline[1].items[0]
  assert.equal(tool.kind, 'tool')
  assert.equal(tool.result.text, 'file-a')
})

test('a call without a result stays open', () => {
  const [message] = buildTimeline([{ id: 'a1', role: 'assistant', blocks: [use('t1')] }])
  assert.equal(message.items[0].result, undefined)
})

test('a result whose call is unknown is kept on its own', () => {
  const [message] = buildTimeline([{ id: 'u1', role: 'user', blocks: [result('missing')] }])
  assert.equal(message.items[0].kind, 'tool')
  assert.equal(message.items[0].use, undefined)
})

test('todo calls become a checklist item', () => {
  const todos = [{ content: 'a', status: 'completed' }]
  const [message] = buildTimeline([{ id: 'a1', role: 'assistant', blocks: [{ ...use('t1', 'TodoWrite'), todos }] }])
  assert.equal(message.items[0].kind, 'todos')
})
