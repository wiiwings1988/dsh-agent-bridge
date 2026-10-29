import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'extras-'))
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig')
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
const { Scheduler, StateStore, changeSkill, listSkills, mcpChange, prepareAttachments, readGitConfig, writeGitConfig } = await import('../src/extras.ts')
const { readClaudeUsage, searchClaude } = await import('../src/claude.ts')
const { promptOf } = await import('../src/run.ts')

test('state: values persist across a restart and the file is private', () => {
  const path = join(home, 'state', 'state.json')
  const first = new StateStore(path)
  first.set('drafts', { a: 'hello' }); first.set('archived', ['claude:x'])
  const second = new StateStore(path)
  assert.deepEqual(second.get('drafts'), { a: 'hello' })
  assert.deepEqual(second.get('archived'), ['claude:x'])
  assert.equal(execFileSync('stat', ['-f', '%Lp', path], { encoding: 'utf8' }).trim(), '600')
  writeFileSync(path, '{not json')
  assert.deepEqual(new StateStore(path).get('archived'), [], 'an unreadable file starts empty instead of crashing')
})

test('state: a missing file reads the file under the previous plugin name, then writes to its own path', () => {
  const path = join(home, 'renamed', 'agent-bridge', 'state.json')
  const legacy = join(home, 'renamed', 'external-engines', 'state.json')
  mkdirSync(dirname(legacy), { recursive: true })
  writeFileSync(legacy, JSON.stringify({ pinned: ['claude:p'], archived: ['claude:a'] }))
  const store = new StateStore(path, legacy)
  assert.deepEqual(store.get('pinned'), ['claude:p'])
  store.set('drafts', { b: 'x' })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).archived, ['claude:a'], 'the first write carries the old state over')
  assert.deepEqual(JSON.parse(readFileSync(legacy, 'utf8')), { pinned: ['claude:p'], archived: ['claude:a'] }, 'the old file stays as it was')
  writeFileSync(legacy, JSON.stringify({ pinned: ['claude:stale'] }))
  assert.deepEqual(new StateStore(path, legacy).get('pinned'), ['claude:p'], 'once its own file exists the old one is ignored')
})

test('skills: add, list, refuse duplicates and bad names, remove', async () => {
  const project = mkdtempSync(join(tmpdir(), 'proj-'))
  await changeSkill({ cwd: project, action: 'add', name: 'my-skill', scope: 'user', description: 'Does a thing', body: 'Steps' })
  await changeSkill({ cwd: project, action: 'add', name: 'proj-skill', scope: 'project', description: 'Project one', body: 'x' })
  const skills = await listSkills(project)
  assert.deepEqual(skills.map(s => `${s.scope}:${s.name}:${s.description}`).sort(), ['project:proj-skill:Project one', 'user:my-skill:Does a thing'])
  assert.match(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'skills/my-skill/SKILL.md'), 'utf8'), /^---\nname: my-skill/)
  await assert.rejects(changeSkill({ cwd: project, action: 'add', name: 'my-skill', scope: 'user', description: '', body: '' }), /already exists/)
  await assert.rejects(changeSkill({ cwd: project, action: 'add', name: '../evil', scope: 'user', description: '', body: '' }), /invalid skill name/)
  await changeSkill({ cwd: project, action: 'remove', name: 'my-skill', scope: 'user' })
  assert.equal(existsSync(join(process.env.CLAUDE_CONFIG_DIR, 'skills/my-skill')), false)
})

test('mcp: add and remove go through the Claude CLI into the configuration', async () => {
  const project = mkdtempSync(join(tmpdir(), 'proj-'))
  await mcpChange('', { cwd: project, action: 'add', name: 'demo', scope: 'user', config: { type: 'stdio', command: 'echo', args: ['hi'] } })
  const file = join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.demo.command, 'echo')
  await assert.rejects(mcpChange('', { cwd: project, action: 'add', name: 'bad name', scope: 'user', config: {} }), /invalid server name/)
  await mcpChange('', { cwd: project, action: 'remove', name: 'demo', scope: 'user' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers?.demo, undefined)
})

test('git identity: read and write the global config only', async () => {
  assert.deepEqual(await readGitConfig(), { name: '', email: '' })
  await writeGitConfig('Tester', 't@example.com')
  assert.deepEqual(await readGitConfig(), { name: 'Tester', email: 't@example.com' })
  await assert.rejects(writeGitConfig('a\nb', ''), /invalid value/)
})

test('attachments: images travel in the message, other files get a path note, names cannot escape', async () => {
  const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64')
  const prepared = await prepareAttachments([
    { name: 'shot.png', mime: 'image/png', base64: png },
    { name: '../../etc/passwd', mime: 'text/plain', base64: Buffer.from('x').toString('base64') },
  ])
  assert.equal(prepared.images.length, 1)
  assert.equal(prepared.paths.length, 2)
  assert.ok(prepared.paths.every(p => p.startsWith(tmpdir()) || p.startsWith('/private')), 'files stay in the temp folder')
  assert.match(prepared.note, /Attached files:\n- .*passwd/)
  assert.ok(!prepared.note.includes('shot.png'), 'images are not listed as files')
  assert.deepEqual(await prepareAttachments(undefined), { images: [], paths: [], imagePaths: [], note: '' })
})

test('usage and search read the session file', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-x'); mkdirSync(dir, { recursive: true })
  const rec = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content, ...extra }, uuid: Math.random().toString() })
  writeFileSync(join(dir, `${id}.jsonl`), [
    rec('user', 'please find the NEEDLE-word here'),
    rec('assistant', [{ type: 'text', text: 'first block' }], { id: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } }),
    rec('assistant', [{ type: 'text', text: 'second block of the same response' }], { id: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } }),
    rec('assistant', [{ type: 'text', text: 'next response' }], { id: 'm2', usage: { input_tokens: 1, output_tokens: 2 } }),
  ].join('\n'))
  assert.deepEqual(await readClaudeUsage(id), { input: 11, output: 7, cacheRead: 100, cacheWrite: 7 })
  const hits = await searchClaude([{ id: `claude:${id}`, title: 'T', cwd: '/x', updatedAt: 0 }, { id: 'claude:22222222-2222-4222-8222-222222222222', title: 'gone', cwd: '', updatedAt: 0 }], 'needle-word', 10)
  assert.equal(hits.length, 1)
  assert.match(hits[0].snippet, /NEEDLE-word/)
  assert.deepEqual(await searchClaude([{ id: `claude:${id}`, title: 'T', cwd: '/x', updatedAt: 0 }], 'absent-term', 10), [])
})

test('the prompt is plain text without images, and one user message with image blocks before the text with images', async () => {
  assert.equal(promptOf({ text: 'hi' }), 'hi')
  assert.equal(promptOf({ text: 'hi', images: [] }), 'hi')
  const stream = promptOf({ text: 'look', images: [{ mime: 'image/png', base64: 'AAAA' }, { mime: 'image/jpeg', base64: 'BBBB' }] })
  const messages = []
  for await (const message of stream) messages.push(message)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].type, 'user')
  assert.deepEqual(messages[0].message.content.map(block => block.type), ['image', 'image', 'text'])
  assert.deepEqual(messages[0].message.content[1].source, { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' })
  assert.equal(messages[0].message.content[2].text, 'look')
})

test('scheduler: sends once when due, waits for a busy session, gives up eventually, records failures, cancels, survives a restart', async () => {
  const path = join(home, 'sched', 'state.json')
  let clock = 1_000_000
  const sent = []
  let busy = false
  let fail = false
  const make = () => new Scheduler(new StateStore(path), async (m) => { if (fail) throw new Error('boom'); sent.push(m.text) }, () => busy, () => clock)
  let scheduler = make()
  scheduler.add({ sessionId: 'claude:s1', cwd: '/x', text: 'later', at: clock + 5000 })
  scheduler.add({ sessionId: 'claude:s1', cwd: '/x', text: 'soon', at: clock + 1000, model: 'opus' })
  assert.throws(() => scheduler.add({ sessionId: 'claude:s1', cwd: '/x', text: '', at: clock + 10 }), /empty/)
  assert.throws(() => scheduler.add({ sessionId: 'claude:s1', cwd: '/x', text: 'old', at: clock - 60_000 }), /past/)
  await scheduler.tick()
  assert.deepEqual(sent, [], 'nothing is due yet')
  scheduler = make() // restart: the queue is read back from the state file
  assert.deepEqual(scheduler.list('claude:s1').map(m => m.text), ['soon', 'later'])
  clock += 1500
  await scheduler.tick(); await scheduler.tick()
  assert.deepEqual(sent, ['soon'], 'sent exactly once')
  busy = true; clock += 4000
  await scheduler.tick()
  assert.deepEqual(sent, ['soon'], 'a busy session keeps the message waiting')
  assert.equal(scheduler.list('claude:s1').find(m => m.text === 'later').status, 'pending')
  busy = false
  await scheduler.tick()
  assert.deepEqual(sent, ['soon', 'later'])
  scheduler.add({ sessionId: 'claude:s1', cwd: '/x', text: 'will fail', at: clock + 100 })
  clock += 200; fail = true
  await scheduler.tick()
  const failed = scheduler.list('claude:s1').find(m => m.text === 'will fail')
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'boom')
  fail = false
  const cancelled = scheduler.add({ sessionId: 'claude:s1', cwd: '/x', text: 'never', at: clock + 100 })
  assert.equal(scheduler.cancel(cancelled.id), true)
  assert.equal(scheduler.cancel(cancelled.id), false)
  busy = true; const stuck = scheduler.add({ sessionId: 'claude:s2', cwd: '/x', text: 'stuck', at: clock + 10 })
  clock += 11 * 60_000
  await scheduler.tick()
  assert.equal(scheduler.list('claude:s2').find(m => m.id === stuck.id).status, 'failed')
  clock += 8 * 24 * 3_600_000
  await scheduler.tick()
  assert.deepEqual(scheduler.list('claude:s1'), [], 'finished entries are dropped after a week')
})
