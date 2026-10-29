import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_MARK_CSS } from '../src/client/branding.tsx'

/** Decoded svg drawn for one engine's session-row mark. */
function markSvg(engine) {
  const rule = ENGINE_MARK_CSS.split('\n').find(line => line.startsWith(`[data-engine="${engine}"] { background-image`))
  assert.ok(rule, `no mark rule for ${engine}`)
  return decodeURIComponent(/data:image\/svg\+xml,([^"]+)"/.exec(rule)[1])
}

test('dsh rows show the DeepSeek whale in the text colour, like the app logo, not a coloured engine mark', () => {
  const rule = ENGINE_MARK_CSS.split('\n').find(line => line.startsWith('[data-engine="dsh"]'))
  assert.ok(rule, 'no mark rule for dsh')
  assert.match(rule, /background-color: var\(--dsw-alias-label-primary\)/)
  assert.doesNotMatch(rule, /background-image/)
  const svg = decodeURIComponent(/mask: url\("data:image\/svg\+xml,([^"]+)"\)/.exec(rule)[1])
  assert.ok(svg.includes("<path d='M23.748 4.482c-.254-.124-.364.113-.512.234"), 'not the DeepSeek whale outline')
})

test('codex rows show the official Codex cloud with its prompt glyph and gradient', () => {
  const svg = markSvg('codex')
  assert.ok(svg.includes("<path d='M9.064 3.344a4.578 4.578 0 012.285-.312"), 'not the Codex cloud outline')
  assert.match(svg, /stop-color='#3941FF'/)
})

test('claude rows show the official Claude spark in Claude orange', () => {
  const svg = markSvg('claude')
  assert.match(svg, /fill='#D97757'/)
  assert.ok(svg.includes("<path d='M4.709 15.955l4.72-2.647"), 'not the Claude spark outline')
})

test('every engine mark draws at one size, keeping the title where it was', () => {
  assert.match(ENGINE_MARK_CSS, /\[data-engine\] \{ width: 16px; height: 16px; margin: 0 5px 0 -1px;/)
  const sized = ENGINE_MARK_CSS.split('\n').filter(line => /\[data-engine="[a-z]+"\][^{]*\{[^}]*(width|height|margin)/.test(line))
  assert.deepEqual(sized, [], 'no engine may override the shared size')
})
