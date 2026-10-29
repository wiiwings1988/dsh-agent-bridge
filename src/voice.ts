/**
 * Speech to text and text to speech through an OpenAI-compatible backend the user configures.
 * Nothing is sent anywhere unless a base address is set.
 * @module dsh-agent-bridge/voice
 */
import type { VoiceBodyWire } from './protocol.ts'
import { HttpError } from './workbench.ts'

/** Backend settings. */
export interface VoiceConfig {
  readonly baseUrl: string
  /** Name of the environment variable that holds the key; empty sends none. */
  readonly apiKeyEnv: string
  readonly sttModel: string
  readonly ttsModel: string
  readonly ttsVoice: string
}

const AUDIO_LIMIT = 25_000_000
const SPEECH_LIMIT = 4000

const EXTENSION: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' }

function endpoint(config: VoiceConfig, path: string): { url: string; headers: Record<string, string> } {
  if (config.baseUrl.trim() === '') throw new HttpError(404, 'voice is not configured')
  const key = config.apiKeyEnv === '' ? undefined : process.env[config.apiKeyEnv]
  return { url: `${config.baseUrl.replace(/\/$/, '')}${path}`, headers: key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` } }
}

/**
 * Run one voice action.
 * @param body - the request.
 * @param config - backend settings.
 * @param fetchImpl - replaceable in tests.
 * @returns the transcript, or the spoken audio.
 */
export async function voiceAction(
  body: VoiceBodyWire, config: VoiceConfig, fetchImpl: typeof fetch = fetch,
): Promise<{ text: string } | { mime: string; base64: string }> {
  if (body.action === 'transcribe') {
    const { url, headers } = endpoint(config, '/v1/audio/transcriptions')
    const audio = Buffer.from(body.base64, 'base64')
    if (audio.length === 0 || audio.length > AUDIO_LIMIT) throw new HttpError(413, 'the recording is empty or too large')
    const form = new FormData()
    form.set('model', config.sttModel)
    form.set('file', new Blob([audio], { type: body.mime }), `speech.${EXTENSION[body.mime.split(';')[0] ?? ''] ?? 'webm'}`)
    const response = await fetchImpl(url, { method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw new HttpError(502, `speech backend: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    const result = await response.json() as { text?: string }
    return { text: result.text ?? '' }
  }
  const { url, headers } = endpoint(config, '/v1/audio/speech')
  const text = body.text.slice(0, SPEECH_LIMIT)
  if (text.trim() === '') throw new HttpError(400, 'nothing to speak')
  const response = await fetchImpl(url, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, redirect: 'manual',
    body: JSON.stringify({ model: config.ttsModel, voice: config.ttsVoice, input: text, response_format: 'mp3' }), signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) throw new HttpError(502, `speech backend: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  return { mime: response.headers.get('content-type')?.split(';')[0] ?? 'audio/mpeg', base64: Buffer.from(await response.arrayBuffer()).toString('base64') }
}
