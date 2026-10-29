import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { voiceAction } from '../src/voice.ts'

/** A local stand-in for an OpenAI-compatible speech service. */
async function backend() {
  const seen = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ url: request.url, auth: request.headers.authorization, type: request.headers['content-type'], body })
      if (request.url === '/v1/audio/transcriptions') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ text: 'hello from the recording' })) }
      else if (request.url === '/v1/audio/speech') { response.setHeader('content-type', 'audio/mpeg'); response.end(Buffer.from([1, 2, 3, 4])) }
      else { response.statusCode = 500; response.end('nope') }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

test('voice: a recording is sent as a multipart upload with the key, and the transcript comes back', async () => {
  const b = await backend()
  process.env.TEST_VOICE_KEY = 'secret-key'
  try {
    const config = { baseUrl: `${b.url}/`, apiKeyEnv: 'TEST_VOICE_KEY', sttModel: 'whisper-x', ttsModel: 'tts-x', ttsVoice: 'v' }
    const result = await voiceAction({ action: 'transcribe', base64: Buffer.from('audio-bytes').toString('base64'), mime: 'audio/webm;codecs=opus' }, config)
    assert.deepEqual(result, { text: 'hello from the recording' })
    const request = b.seen[0]
    assert.equal(request.auth, 'Bearer secret-key')
    assert.match(request.type, /^multipart\/form-data/)
    assert.match(request.body.toString('latin1'), /name="model"\r\n\r\nwhisper-x/)
    assert.match(request.body.toString('latin1'), /filename="speech\.webm"/)
    assert.match(request.body.toString('latin1'), /audio-bytes/)
    const spoken = await voiceAction({ action: 'speak', text: 'say this' }, config)
    assert.deepEqual([spoken.mime, [...Buffer.from(spoken.base64, 'base64')]], ['audio/mpeg', [1, 2, 3, 4]])
    assert.deepEqual(JSON.parse(b.seen[1].body.toString()), { model: 'tts-x', voice: 'v', input: 'say this', response_format: 'mp3' })
  } finally { b.close() }
})

test('voice: nothing is sent without a base address, empty input and backend errors are reported', async () => {
  await assert.rejects(voiceAction({ action: 'speak', text: 'x' }, { baseUrl: '', apiKeyEnv: '', sttModel: '', ttsModel: '', ttsVoice: '' }), /not configured/)
  const b = await backend()
  try {
    const config = { baseUrl: b.url, apiKeyEnv: '', sttModel: 'm', ttsModel: 'm', ttsVoice: 'v' }
    await assert.rejects(voiceAction({ action: 'transcribe', base64: '', mime: 'audio/webm' }, config), /empty or too large/)
    await assert.rejects(voiceAction({ action: 'speak', text: '   ' }, config), /nothing to speak/)
    assert.equal(b.seen.length, 0, 'invalid requests never reach the backend')
    const broken = { ...config, baseUrl: `${b.url}/wrong` }
    await assert.rejects(voiceAction({ action: 'speak', text: 'x' }, broken), /speech backend: HTTP 500/)
    assert.equal(b.seen[0].auth, undefined, 'no key header without a key')
  } finally { b.close() }
})
