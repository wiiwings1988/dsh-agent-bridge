import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTasks, setStatus, tasksAction } from '../src/taskmaster.ts'

const project = (layout) => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-'))
  mkdirSync(join(dir, '.taskmaster', 'tasks'), { recursive: true })
  const tasks = [
    { id: 1, title: 'First', description: 'd1', status: 'done', priority: 'high', dependencies: [], subtasks: [{ id: 1, title: 'Sub', status: 'pending' }] },
    { id: 2, title: 'Second', description: 'd2', status: 'pending', dependencies: [1] },
  ]
  writeFileSync(join(dir, '.taskmaster', 'tasks', 'tasks.json'), JSON.stringify(layout === 'tagged' ? { master: { tasks }, feature: { tasks: [{ id: 9, title: 'F', status: 'pending' }] } } : { tasks }))
  return dir
}

test('tasks: both file layouts are read, tags are listed, subtasks get dotted ids', async () => {
  const flat = await readTasks(project('flat'))
  assert.deepEqual(flat.tasks.map(t => [t.id, t.status]), [['1', 'done'], ['2', 'pending']])
  assert.deepEqual(flat.tasks[0].subtasks.map(t => t.id), ['1.1'])
  assert.deepEqual(flat.tasks[1].dependencies, ['1'])
  const dir = project('tagged')
  const tagged = await readTasks(dir)
  assert.deepEqual(tagged.tags, ['master', 'feature']); assert.equal(tagged.tag, 'master')
  assert.deepEqual((await readTasks(dir, 'feature')).tasks.map(t => t.id), ['9'])
  const empty = await readTasks(mkdtempSync(join(tmpdir(), 'tm-empty-')))
  assert.deepEqual([empty.initialized, empty.tasks.length], [false, 0])
})

test('tasks: status changes are written to tasks.json for tasks and subtasks, bad input is refused', async () => {
  const dir = project('tagged')
  await setStatus(dir, '2', 'in-progress')
  await setStatus(dir, '1.1', 'done')
  await setStatus(dir, '9', 'review', 'feature')
  const after = JSON.parse(readFileSync(join(dir, '.taskmaster/tasks/tasks.json'), 'utf8'))
  assert.equal(after.master.tasks[1].status, 'in-progress')
  assert.equal(after.master.tasks[0].subtasks[0].status, 'done')
  assert.equal(after.feature.tasks[0].status, 'review')
  assert.equal(after.master.tasks[1].dependencies[0], 1, 'other fields are left alone')
  await assert.rejects(setStatus(dir, '2', 'bogus'), /unknown status/)
  await assert.rejects(setStatus(dir, '77', 'done'), /not found/)
  await assert.rejects(setStatus(dir, '1.7', 'done'), /subtask 1.7 not found/)
  await assert.rejects(setStatus(mkdtempSync(join(tmpdir(), 'tm-none-')), '1', 'done'), /no tasks.json/)
})

test('prd files: write, list, read, delete; names cannot escape the docs folder', async () => {
  const dir = project('flat')
  await tasksAction({ cwd: dir, action: 'prd-write', file: 'plan.md', content: '# Plan\n' })
  await tasksAction({ cwd: dir, action: 'prd-write', file: 'other.txt', content: 'x' })
  assert.deepEqual((await readTasks(dir)).prds, ['other.txt', 'plan.md'])
  assert.equal((await tasksAction({ cwd: dir, action: 'prd-read', file: 'plan.md' })).content, '# Plan\n')
  for (const file of ['../../etc/passwd', '..\\x.md', 'a/b.md', 'noext', '.hidden.md']) {
    await assert.rejects(tasksAction({ cwd: dir, action: 'prd-write', file, content: 'x' }), /PRD file name/, file)
  }
  await tasksAction({ cwd: dir, action: 'prd-delete', file: 'other.txt' })
  assert.deepEqual((await readTasks(dir)).prds, ['plan.md'])
})

test('model-backed actions run the task-master command with the right arguments', async () => {
  const dir = project('flat')
  const bin = mkdtempSync(join(tmpdir(), 'fake-tm-'))
  const log = join(bin, 'calls.log')
  const script = join(bin, 'task-master')
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\necho "ran $1"\n`); chmodSync(script, 0o755)
  assert.match((await tasksAction({ cwd: dir, action: 'init' }, script)).output, /ran init/)
  await tasksAction({ cwd: dir, action: 'add', prompt: 'Add login', tag: 'feature' }, script)
  await tasksAction({ cwd: dir, action: 'update', id: '2', prompt: 'Rework it' }, script)
  await tasksAction({ cwd: dir, action: 'prd-write', file: 'plan.md', content: 'x' })
  await tasksAction({ cwd: dir, action: 'parse', file: 'plan.md' }, script)
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'init --yes',
    'add-task --prompt=Add login --tag=feature',
    'update-task --id=2 --prompt=Rework it',
    `parse-prd ${join(dir, '.taskmaster/docs/plan.md')}`,
  ])
  await assert.rejects(tasksAction({ cwd: dir, action: 'add', prompt: '  ' }, script), /prompt is empty/)
  await assert.rejects(tasksAction({ cwd: dir, action: 'update', id: '2; rm -rf /', prompt: 'x' }, script), /invalid task id/)
  await assert.rejects(tasksAction({ cwd: dir, action: 'parse', file: 'missing.md' }, script), /no such PRD/)
  const failing = join(bin, 'fail'); writeFileSync(failing, '#!/bin/sh\necho "no API key" >&2\nexit 1\n'); chmodSync(failing, 0o755)
  await assert.rejects(tasksAction({ cwd: dir, action: 'add', prompt: 'x' }, failing), /no API key/)
  assert.ok(existsSync(join(dir, '.taskmaster/tasks/tasks.json')))
})
