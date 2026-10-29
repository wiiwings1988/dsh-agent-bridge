/** Dictation into the message box and reading a reply aloud, through the configured speech backend. */
import { useEffect, useRef, useState } from 'react'
import { IconMic, IconSpeaker } from './icons.tsx'
import { VOICE_PATH, type VoiceStatusWire } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import { call, message } from './workbench/api.tsx'

let enabled: Promise<boolean> | undefined

/** @returns whether a speech backend is configured (asked once per page load). */
export function voiceEnabled(): Promise<boolean> {
  enabled ??= call<VoiceStatusWire>(VOICE_PATH).then(status => status.enabled, () => false)
  return enabled
}

/** Hook over {@link voiceEnabled}. */
export function useVoiceEnabled(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => { void voiceEnabled().then(setOn) }, [])
  return on
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Record from the microphone; the transcript is handed to `onText`. */
export function DictateButton({ onText, t, className }: { onText: (text: string) => void; t: Translate; className?: string | undefined }) {
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const [state, setState] = useState<'idle' | 'recording' | 'sending'>('idle')
  const [error, setError] = useState<string | undefined>(undefined)
  const start = async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: Blob[] = []
      const next = new MediaRecorder(stream)
      next.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      next.onstop = () => {
        for (const track of stream.getTracks()) track.stop()
        setState('sending')
        const blob = new Blob(chunks, { type: next.mimeType || 'audio/webm' })
        void toBase64(blob)
          .then(base64 => call<{ text: string }>(VOICE_PATH, { body: { action: 'transcribe', base64, mime: blob.type } }))
          .then(({ text }) => { onText(text); setError(undefined) }, (reason: unknown) => { setError(message(reason)) })
          .finally(() => { setState('idle') })
      }
      recorder.current = next
      next.start()
      setState('recording')
    } catch (reason) { setError(message(reason)) }
  }
  return (
    <>
      <button
        type="button" className={className} data-testid="ext-dictate" data-state={state} disabled={state === 'sending'} aria-pressed={state === 'recording'}
        aria-label={state === 'recording' ? t('voice.stop') : t('voice.dictate')} title={state === 'recording' ? t('voice.stop') : t('voice.dictate')}
        onClick={() => { if (state === 'recording') recorder.current?.stop(); else void start() }}
      ><IconMic size={16} /></button>
      {error !== undefined && <span role="alert" data-testid="ext-voice-error">{error}</span>}
    </>
  )
}

/** Read a piece of text aloud. */
export function SpeakButton({ text, t, className }: { text: string; t: Translate; className?: string | undefined }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <>
      <button
        type="button" className={className} data-testid="ext-speak" disabled={busy} aria-label={t('voice.speak')} title={t('voice.speak')}
        onClick={() => {
          setBusy(true)
          void call<{ mime: string; base64: string }>(VOICE_PATH, { body: { action: 'speak', text } })
            .then(({ mime, base64 }) => new Audio(`data:${mime};base64,${base64}`).play())
            .then(() => { setError(undefined) }, (reason: unknown) => { setError(message(reason)) })
            .finally(() => { setBusy(false) })
        }}
      ><IconSpeaker size={16} /></button>
      {error !== undefined && <span role="alert" data-testid="ext-voice-error">{error}</span>}
    </>
  )
}
