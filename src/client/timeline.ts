/** Turns transcript messages into the items the panel draws: tool calls merged with their results. */
import type { BlockWire, MessageWire, TodoWire } from '../protocol.ts'

type ToolUse = Extract<BlockWire, { type: 'tool_use' }>
type ToolResult = Extract<BlockWire, { type: 'tool_result' }>

/** One thing the panel draws inside a message. */
export type TimelineItem =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'todos'; readonly todos: readonly TodoWire[] }
  | { readonly kind: 'tool'; readonly use: ToolUse | undefined; readonly result: ToolResult | undefined }

/** One drawn message; messages that only carried tool results do not appear. */
export interface TimelineMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly items: readonly TimelineItem[]
}

/**
 * Pair every tool call with its result and drop the messages that held only results.
 * A result joins the call whose `id` equals its `forId`; a result with no known call is kept as its own item.
 * @param messages - transcript messages in file order.
 * @returns messages ready to draw.
 */
export function buildTimeline(messages: readonly MessageWire[]): TimelineMessage[] {
  const results = new Map<string, ToolResult>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_result' && block.forId !== undefined) results.set(block.forId, block)
    }
  }
  const calls = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.id !== undefined) calls.add(block.id)
    }
  }
  const timeline: TimelineMessage[] = []
  for (const message of messages) {
    const items: TimelineItem[] = []
    for (const block of message.blocks) {
      switch (block.type) {
        case 'text':
          items.push({ kind: 'text', text: block.text })
          break
        case 'thinking':
          items.push({ kind: 'thinking', text: block.text })
          break
        case 'tool_use':
          items.push(block.todos === undefined
            ? { kind: 'tool', use: block, result: block.id === undefined ? undefined : results.get(block.id) }
            : { kind: 'todos', todos: block.todos })
          break
        case 'tool_result':
          if (block.forId === undefined || !calls.has(block.forId)) items.push({ kind: 'tool', use: undefined, result: block })
          break
      }
    }
    if (items.length > 0) timeline.push({ id: message.id, role: message.role, items })
  }
  return timeline
}
