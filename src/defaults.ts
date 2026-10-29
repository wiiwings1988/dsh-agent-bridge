/** Names for what an engine uses when the user leaves the model and effort to it. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelWire } from './protocol.ts'

const slug = (name: string): string => name.toLowerCase().replace(/[\s.]+/g, '-')

/**
 * Display name of a model id.
 * @param id - model id the engine reports, such as `claude-opus-5-5`.
 * @param models - the engine's model list.
 * @returns the name of the entry with this value, else of the entry whose name in id form is the longest part of the id, else the id.
 */
export function modelLabel(id: string, models: readonly ModelWire[]): string {
  const exact = models.find(model => model.value === id)
  if (exact !== undefined) return exact.name
  const lower = id.toLowerCase()
  const named = models.filter(model => lower.includes(slug(model.name))).sort((a, b) => slug(b.name).length - slug(a.name).length)
  return named[0]?.name ?? id
}

/**
 * The `effortLevel` of the user's Claude Code settings.
 * @param configDir - Claude Code configuration directory.
 * @returns the level, or undefined when the file or the field is missing or unreadable.
 */
export function readClaudeEffortSetting(configDir: string): string | undefined {
  let settings: { effortLevel?: unknown }
  try {
    settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { effortLevel?: unknown }
  } catch {
    // A missing or malformed settings file leaves the effort to Claude Code.
    return undefined
  }
  return typeof settings.effortLevel === 'string' && settings.effortLevel !== '' ? settings.effortLevel : undefined
}
