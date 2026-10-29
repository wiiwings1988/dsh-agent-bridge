/** Per-session live event buffer and subscriber fan-out shared by the engine drivers. */
import type { LiveEventWire } from './protocol.ts'

/** Receives live events of one session. */
export type Subscriber = (event: LiveEventWire) => void

interface ActiveTurn {
  readonly events: LiveEventWire[]
  /** Assistant text streamed since the last completed message. */
  partial: string
}

/** Buffers the events of each running turn so late subscribers can catch up. */
export class LiveHub {
  private readonly active = new Map<string, ActiveTurn>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()

  /**
   * Mark a session as running.
   * @param sessionId - session id.
   */
  begin(sessionId: string): void {
    this.active.set(sessionId, { events: [], partial: '' })
  }

  /**
   * Record an event of the running turn and deliver it to the subscribers.
   * @param sessionId - session id.
   * @param event - the event.
   */
  emit(sessionId: string, event: LiveEventWire): void {
    const turn = this.active.get(sessionId)
    if (turn !== undefined) {
      if (event.kind === 'delta') turn.partial += event.text
      else {
        if (event.kind === 'message') turn.partial = ''
        turn.events.push(event)
      }
    }
    for (const subscriber of this.subscribers.get(sessionId) ?? []) subscriber(event)
  }

  /**
   * Mark a session as no longer running; later subscribers see `idle`.
   * @param sessionId - session id.
   */
  end(sessionId: string): void {
    this.active.delete(sessionId)
  }

  /**
   * Subscribe to one session; a running turn's events are replayed first, then the accumulated text.
   * @param sessionId - session id.
   * @param subscriber - event callback.
   * @returns the unsubscribe function.
   */
  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    const turn = this.active.get(sessionId)
    if (turn === undefined) subscriber({ kind: 'idle' })
    else {
      for (const event of turn.events) subscriber(event)
      subscriber({ kind: 'delta', text: turn.partial })
    }
    const set = this.subscribers.get(sessionId) ?? new Set()
    set.add(subscriber)
    this.subscribers.set(sessionId, set)
    return () => { set.delete(subscriber) }
  }
}
