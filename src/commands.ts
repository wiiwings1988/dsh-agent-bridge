/**
 * Lookup of the command-line tools the plugin starts (Claude Code, Codex, Peekaboo).
 * @module dsh-agent-bridge/commands
 */
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Install directories searched after PATH: a desktop app launched from Finder or the Dock inherits a short PATH. */
export const INSTALL_DIRS: readonly string[] = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
  } catch { /* missing or not executable: try the next directory */
    return false
  }
  return statSync(path).isFile()
}

/**
 * Turn a configured command into the path to start.
 * @param command - a bare name such as `claude`, or a path; a value containing `/` is used as written.
 * @param env - environment whose PATH is searched first.
 * @param extraDirs - directories searched after PATH.
 * @returns the first executable match, or `command` unchanged when nothing matches so the start error names it.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env, extraDirs: readonly string[] = INSTALL_DIRS): string {
  if (command.includes('/')) return command
  const dirs = [...(env['PATH'] ?? '').split(delimiter).filter(dir => dir !== ''), ...extraDirs]
  return dirs.map(dir => join(dir, command)).find(isExecutable) ?? command
}
