/**
 * Read-only access to Claude Code sessions stored by the local `claude` CLI. Listing and transcript
 * parsing go through the Claude Agent SDK; the SDK honors `CLAUDE_CONFIG_DIR`.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deleteSession, forkSession, getSessionMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk'
import {
  CLAUDE_ID_PREFIX,
  type BlockWire, type GoalWire, type MessageWire, type SearchHitWire, type SessionRowWire, type TodoWire, type UsageWire,
} from './protocol.ts'

/** @returns the Claude Code configuration directory the SDK reads. */
export function claudeConfigDir(): string {
  const configured = process.env['CLAUDE_CONFIG_DIR']
  return configured === undefined || configured === '' ? join(homedir(), '.claude') : configured
}

/**
 * List sessions, newest first.
 * @param limit - maximum number of rows.
 * @returns rows whose ids carry the Claude prefix.
 */
export async function listClaudeRows(limit: number): Promise<SessionRowWire[]> {
  const sessions = await listSessions({ limit })
  return sessions.map(info => ({
    id: `${CLAUDE_ID_PREFIX}${info.sessionId}`,
    title: info.customTitle ?? info.summary ?? info.firstPrompt ?? info.sessionId,
    cwd: info.cwd ?? '',
    updatedAt: info.lastModified,
  }))
}

function summarizeInput(input: unknown): string {
  const text = JSON.stringify(input)
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/** Longest string kept in structured tool arguments. */
const ARG_STRING_LIMIT = 20_000

function capStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.length > ARG_STRING_LIMIT ? `${value.slice(0, ARG_STRING_LIMIT)}…` : value
  if (Array.isArray(value)) return value.map(capStrings)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item)]))
  return value
}

function todosOf(name: string, input: unknown): TodoWire[] | undefined {
  const items = (input as { todos?: unknown }).todos
  if (name !== 'TodoWrite' || !Array.isArray(items)) return undefined
  return items.map((item: { content?: unknown; status?: unknown }) => ({ content: String(item.content ?? ''), status: String(item.status ?? '') }))
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part: { type?: string }) => part.type !== 'image')
    .map((part: { type?: string; text?: string }) => part.type === 'text' ? part.text ?? '' : `[${part.type ?? 'unknown'}]`).join('\n')
}

function resultImages(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part: { type?: string; source?: { type?: string; media_type?: string; data?: string } }) =>
    part.type === 'image' && part.source?.type === 'base64' ? [`data:${part.source.media_type ?? 'image/png'};base64,${part.source.data ?? ''}`] : [])
}

function toBlocks(content: unknown): BlockWire[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: BlockWire[] = []
  for (const part of content as Array<Record<string, unknown>>) {
    switch (part['type']) {
      case 'text':
        blocks.push({ type: 'text', text: String(part['text'] ?? '') })
        break
      case 'thinking':
        blocks.push({ type: 'thinking', text: String(part['thinking'] ?? '') })
        break
      case 'tool_use':
      {
        const name = String(part['name'] ?? '')
        const todos = todosOf(name, part['input'])
        const args = capStrings(part['input'])
        blocks.push({
          type: 'tool_use', name, input: summarizeInput(part['input']),
          ...typeof part['id'] === 'string' ? { id: part['id'] } : {},
          ...args !== null && typeof args === 'object' && !Array.isArray(args) ? { args: args as Record<string, unknown> } : {},
          ...todos === undefined ? {} : { todos },
        })
      }
        break
      case 'tool_result':
        {
          const images = resultImages(part['content'])
          blocks.push({
            type: 'tool_result', text: resultText(part['content']),
            ...images.length === 0 ? {} : { images },
            ...typeof part['tool_use_id'] === 'string' ? { forId: part['tool_use_id'] } : {},
            ...part['is_error'] === true ? { isError: true } : {},
          })
        }
        break
      default:
        blocks.push({ type: 'text', text: `[${String(part['type'])}]` })
    }
  }
  return blocks
}

/**
 * Read one session's transcript.
 * @param sessionId - Claude session UUID (no prefix).
 * @returns user and assistant messages in file order.
 */
export async function readClaudeMessages(sessionId: string): Promise<MessageWire[]> {
  const messages = await getSessionMessages(sessionId)
  return messages.flatMap((entry): MessageWire[] => {
    if (entry.type !== 'user' && entry.type !== 'assistant') return []
    const body = entry.message as { content?: unknown }
    return [{ id: entry.uuid, role: entry.type, blocks: toBlocks(body.content) }]
  })
}

/**
 * Locate a session's transcript file.
 * @param sessionId - Claude session UUID (no prefix).
 * @returns absolute path, or undefined when no project folder holds it.
 */
export async function findClaudeFile(sessionId: string): Promise<string | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined
  const projects = join(claudeConfigDir(), 'projects')
  const folders = await readdir(projects)
  for (const folder of folders) {
    const candidate = join(projects, folder, `${sessionId}.jsonl`)
    const exists = await stat(candidate).then(() => true, () => false)
    if (exists) return candidate
  }
  return undefined
}

const GOAL_CLEAR = /^(clear|stop|off|reset|none|cancel)$/i

/**
 * Read the goal state of a session from its transcript file: the last `goal_status` record decides
 * (not met = active), and a later `/goal clear` command removes it.
 * @param sessionId - Claude session UUID (no prefix).
 * @returns the active goal, or undefined when none is set or it was met or cleared.
 */
export async function readClaudeGoal(sessionId: string): Promise<GoalWire | undefined> {
  const file = await findClaudeFile(sessionId)
  if (file === undefined) return undefined
  let goal: GoalWire | undefined
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.includes('goal_status') && !line.includes('"command":"goal"')) continue
    const record = JSON.parse(line) as {
      attachment?: { type?: string; met?: boolean; condition?: string; iterations?: number; reason?: string }
      commandRun?: { command?: string; args?: string }
    }
    const status = record.attachment
    if (status?.type === 'goal_status') {
      goal = status.met === true ? undefined : {
        condition: status.condition ?? '',
        iterations: status.iterations ?? 0,
        ...status.reason === undefined ? {} : { reason: status.reason },
      }
    } else if (record.commandRun?.command === 'goal' && GOAL_CLEAR.test((record.commandRun.args ?? '').trim())) {
      goal = undefined
    }
  }
  return goal
}

/**
 * Fork a session into a new one with the full transcript.
 * @param sessionId - source session UUID (no prefix).
 * @returns the new session UUID.
 */
export async function forkClaudeSession(sessionId: string): Promise<string> {
  return (await forkSession(sessionId)).sessionId
}

/**
 * Set a session's custom title.
 * @param sessionId - session UUID (no prefix).
 * @param title - new title.
 */
export async function renameClaudeSession(sessionId: string, title: string): Promise<void> {
  await renameSession(sessionId, title)
}

/**
 * Delete a session's transcript file.
 * @param sessionId - session UUID (no prefix).
 */
export async function deleteClaudeSession(sessionId: string): Promise<void> {
  await deleteSession(sessionId)
}

/**
 * Sum the token usage recorded in a session file.
 * @param sessionId - Claude session UUID (no prefix).
 * @returns the totals, or undefined when the file has no usage records.
 */
export async function readClaudeUsage(sessionId: string): Promise<UsageWire | undefined> {
  const file = await findClaudeFile(sessionId)
  if (file === undefined) return undefined
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let seen = false
  const counted = new Set<string>()
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.includes('"usage"')) continue
    let record: { type?: string; message?: { id?: string; usage?: Record<string, number> } }
    try { record = JSON.parse(line) as typeof record } catch { continue }
    const usage = record.message?.usage
    if (record.type !== 'assistant' || usage === undefined) continue
    // One API response is written once per content block; count each response once.
    const key = record.message?.id
    if (key !== undefined) { if (counted.has(key)) continue; counted.add(key) }
    seen = true
    total.input += usage['input_tokens'] ?? 0
    total.output += usage['output_tokens'] ?? 0
    total.cacheRead += usage['cache_read_input_tokens'] ?? 0
    total.cacheWrite += usage['cache_creation_input_tokens'] ?? 0
  }
  return seen ? total : undefined
}

/**
 * Find sessions whose conversation text contains `term` (case-insensitive).
 * @param rows - the sessions to look through.
 * @param term - text to find.
 * @param limit - maximum number of hits.
 * @returns one hit per session with the first matching passage.
 */
export async function searchClaude(rows: readonly SessionRowWire[], term: string, limit: number): Promise<SearchHitWire[]> {
  const needle = term.toLowerCase()
  const hits: SearchHitWire[] = []
  for (const row of rows) {
    if (hits.length >= limit) break
    const raw = row.id.slice(CLAUDE_ID_PREFIX.length)
    const file = await findClaudeFile(raw)
    if (file === undefined) continue
    let snippet: string | undefined
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.toLowerCase().includes(needle)) continue
      let record: { type?: string; message?: { content?: unknown } }
      try { record = JSON.parse(line) as typeof record } catch { continue }
      if (record.type !== 'user' && record.type !== 'assistant') continue
      const text = toBlocks(record.message?.content).flatMap(block => block.type === 'text' || block.type === 'thinking' ? [block.text] : []).join('\n')
      const at = text.toLowerCase().indexOf(needle)
      if (at < 0) continue
      snippet = text.slice(Math.max(0, at - 40), at + needle.length + 80).replace(/\s+/g, ' ')
      break
    }
    if (snippet !== undefined) hits.push({ id: row.id, title: row.title, snippet, cwd: row.cwd })
  }
  return hits
}
