import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupByFolder } from '../src/client/sessions.ts'

const rows = [
  { id: 'claude:a', title: 'alpha one', cwd: '/w/alpha', updatedAt: 10 },
  { id: 'codex:b', title: 'beta question', cwd: '/w/beta', updatedAt: 30 },
  { id: 'claude:c', title: 'alpha two', cwd: '/w/alpha', updatedAt: 20 },
  { id: 'claude:d', title: 'root task', cwd: '/', updatedAt: 5 },
]

test('sessions are grouped by folder, newest folder and newest session first', () => {
  const groups = groupByFolder(rows, '')
  assert.deepEqual(groups.map(group => [group.label, group.rows.map(row => row.id)]), [
    ['beta', ['codex:b']],
    ['alpha', ['claude:c', 'claude:a']],
    ['/', ['claude:d']],
  ])
})

test('the search keeps sessions whose title or folder matches, ignoring case', () => {
  assert.deepEqual(groupByFolder(rows, 'ALPHA T').flatMap(group => group.rows.map(row => row.id)), ['claude:c'])
  assert.deepEqual(groupByFolder(rows, '/w/beta').map(group => group.cwd), ['/w/beta'])
  assert.deepEqual(groupByFolder(rows, 'nothing'), [])
})
