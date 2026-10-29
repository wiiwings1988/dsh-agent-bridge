/**
 * Server-sent stream that tells the page when a session file grew.
 * @module dsh-agent-bridge/watch
 */

import { statSync, unwatchFile, watchFile } from 'node:fs'
import type { WatchEventWire } from './protocol.ts'

/**
 * Stream a `changed` event whenever the file's size moves away from its size at open. The file may
 * be missing: Codex compresses idle rollouts to `<path>.zst` and writes `<path>` again when the
 * thread resumes, so a missing file counts as size 0 and its reappearance is reported.
 * @param file - session file to watch.
 * @param intervalMs - polling interval.
 * @param signal - aborts the watch when the client goes away.
 * @returns the event-stream response.
 */
export function watchStream(file: string, intervalMs: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const baseline = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  let release: (() => void) | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const listener = (current: { size: number }): void => {
        if (current.size === baseline) return
        const event: WatchEventWire = { changed: true, size: current.size }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      watchFile(file, { interval: intervalMs }, listener)
      release = () => { unwatchFile(file, listener) }
      signal.addEventListener('abort', () => release?.(), { once: true })
      controller.enqueue(encoder.encode(': watching\n\n'))
    },
    cancel: () => release?.(),
  })
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  })
}
