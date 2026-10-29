/**
 * Writes a synthetic Claude Code config directory (projects/<sanitized-cwd>/<uuid>.jsonl) for the
 * agent-bridge tests. Usage: node make-claude-fixtures.mjs <configDir> <worktreeCwd>
 * Prints the manifest (session id, cwd, expected visible message count) as JSON on stdout.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [configDir, worktreeArg] = process.argv.slice(2)
const worktreeCwd = worktreeArg === undefined ? undefined : resolve(worktreeArg)
if (configDir === undefined || worktreeCwd === undefined) {
  console.error('usage: make-claude-fixtures.mjs <configDir> <worktreeCwd>')
  process.exit(2)
}

const sanitize = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const base = Date.parse('2026-10-01T10:00:00Z')
/** Every assistant response of a fixture session records the same usage, so session totals are easy to predict. */
const USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }

/** One conversation: user/assistant records with thinking and a tool_use/tool_result pair. */
function conversation(sessionId, cwd, startMs, turns) {
  const records = []
  let parent = null
  let n = 0
  const add = (type, message, extra = {}) => {
    n += 1
    const uuid = `${sessionId.slice(0, 24)}${String(n).padStart(12, '0')}`
    records.push({
      parentUuid: parent, isSidechain: false, type, message, uuid,
      timestamp: new Date(startMs + n * 1000).toISOString(),
      userType: 'external', entrypoint: 'cli', cwd, sessionId, version: '2.1.150', gitBranch: 'main', ...extra,
    })
    parent = uuid
  }
  for (const turn of turns) {
    add('user', { role: 'user', content: turn.prompt })
    if (turn.tool !== undefined) {
      const toolId = `toolu_${n}`
      add('assistant', { role: 'assistant', id: `msg_${sessionId.slice(-4)}_${n}`, usage: USAGE, content: [
        { type: 'thinking', thinking: turn.thinking ?? 'plan', signature: 'sig' },
        { type: 'tool_use', id: `toolu_${n}`, name: turn.tool, input: turn.input ?? { command: 'ls' } },
      ] })
      add('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: turn.result ?? 'file-a\nfile-b' }] })
    }
    add('assistant', { role: 'assistant', id: `msg_${sessionId.slice(-4)}_${n}`, usage: USAGE, content: [{ type: 'text', text: turn.reply }] })
  }
  return { records, visible: n }
}

rmSync(configDir, { recursive: true, force: true })
const sessions = [
  { n: 1, cwd: '/tmp/ee-fixture/alpha', turns: [{ prompt: 'alpha one', reply: 'alpha reply' }] },
  { n: 2, cwd: '/tmp/ee-fixture/alpha', turns: [
    { prompt: 'list files', tool: 'Bash', reply: 'There are **two** files:\n\n- `file-a`\n- `file-b`\n\n```sh\nls\n```' },
    { prompt: 'thanks', tool: 'Edit', input: { file_path: '/tmp/ee-fixture/alpha/notes.txt', old_string: 'old-line', new_string: 'new-line' }, result: 'The file has been updated.', reply: 'welcome' },
  ] },
  { n: 3, cwd: '/tmp/ee-fixture/beta', turns: [{ prompt: 'beta question', reply: 'beta answer' }], goal: { condition: 'ship the beta', iterations: 2, reason: 'tests are still failing' } },
  { n: 4, cwd: worktreeCwd, turns: [{ prompt: 'same folder as the dsh workspace', reply: 'ok' }] },
  { n: 5, cwd: '/tmp/ee-fixture/gamma', turns: [{ prompt: 'gamma', reply: 'gamma reply' }] },
  // Taller than the panel, so it shows where the panel is scrolled to.
  { n: 6, cwd: '/tmp/ee-fixture/alpha', turns: Array.from({ length: 40 }, (_, i) => ({ prompt: i === 0 ? 'long conversation' : `question ${i + 1}`, reply: `long reply ${i + 1}` })) },
]
const manifest = []
sessions.forEach((spec, index) => {
  const sessionId = id(spec.n)
  const { records, visible } = conversation(sessionId, spec.cwd, base + index * 3_600_000, spec.turns)
  if (spec.goal !== undefined) {
    const last = records.at(-1)
    records.push({ ...last, type: 'attachment', message: undefined, uuid: `${sessionId.slice(0, 24)}ffffffffffff`, parentUuid: last.uuid,
      attachment: { type: 'goal_status', met: false, ...spec.goal } })
  }
  const dir = join(configDir, 'projects', sanitize(spec.cwd))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  const mtime = new Date(base + index * 3_600_000)
  utimesSync(file, mtime, mtime)
  manifest.push({ sessionId, cwd: spec.cwd, file, records: records.length, visible })
})
console.log(JSON.stringify(manifest))
