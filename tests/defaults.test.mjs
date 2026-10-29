/** Unit gate for the names shown for an engine's own default. Run: ../../../node_modules/.bin/tsx --test tests/defaults.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelLabel, readClaudeEffortSetting } from '../src/defaults.ts'

const claudeModels = [
  { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: [] },
  { value: 'opus', name: 'Opus 5.5', description: '', efforts: [] },
  { value: 'claude-opus-5', name: 'Opus 5', description: '', efforts: [] },
  { value: 'sonnet', name: 'Sonnet 5.5', description: '', efforts: [] },
]

test('a full model id is named after the listed model it belongs to, the longest name winning', () => {
  assert.equal(modelLabel('claude-opus-5-5', claudeModels), 'Opus 5.5')
  assert.equal(modelLabel('claude-opus-5', claudeModels), 'Opus 5')
  assert.equal(modelLabel('claude-sonnet-5-5[1m]', claudeModels), 'Sonnet 5.5')
})

test('a listed value is named by its entry; an unknown id is shown as it is', () => {
  assert.equal(modelLabel('gpt-6-astra', [{ value: 'gpt-6-astra', name: 'GPT-6-Astra', description: '', efforts: [] }]), 'GPT-6-Astra')
  assert.equal(modelLabel('gpt-6.1-sol', [{ value: 'gpt-6-astra', name: 'GPT-6-Astra', description: '', efforts: [] }]), 'gpt-6.1-sol')
  assert.equal(modelLabel('claude-haiku-9', claudeModels), 'claude-haiku-9')
})

test('the Claude effort comes from effortLevel in the user settings, and is absent otherwise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ee-defaults-'))
  assert.equal(readClaudeEffortSetting(dir), undefined)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'opus' }))
  assert.equal(readClaudeEffortSetting(dir), undefined)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ effortLevel: 'high' }))
  assert.equal(readClaudeEffortSetting(dir), 'high')
  writeFileSync(join(dir, 'settings.json'), '{ not json')
  assert.equal(readClaudeEffortSetting(dir), undefined)
})
