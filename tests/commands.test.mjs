import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCommand } from '../src/commands.ts'

const root = mkdtempSync(join(tmpdir(), 'commands-'))
const onPath = join(root, 'bin')
const extra = join(root, 'extra')
mkdirSync(onPath); mkdirSync(extra)
const tool = (dir, name, mode = 0o755) => { const path = join(dir, name); writeFileSync(path, '#!/bin/sh\n'); chmodSync(path, mode); return path }

test('commands: a bare name resolves through PATH, then the extra install directories', () => {
  const claude = tool(onPath, 'claude')
  const codex = tool(extra, 'codex')
  tool(onPath, 'peekaboo', 0o644)
  const env = { PATH: onPath }
  assert.equal(resolveCommand('claude', env, [extra]), claude)
  assert.equal(resolveCommand('codex', env, [extra]), codex, 'a desktop app launched from Finder has a short PATH')
  assert.equal(resolveCommand('peekaboo', env, [extra]), 'peekaboo', 'a file without the execute bit is skipped')
  assert.equal(resolveCommand('missing', env, [extra]), 'missing', 'an unknown name is kept so the spawn error names it')
})

test('commands: a configured path is used as written', () => {
  assert.equal(resolveCommand('/opt/custom/claude', { PATH: onPath }, [extra]), '/opt/custom/claude')
  assert.equal(resolveCommand('./claude', { PATH: onPath }, [extra]), './claude')
})
