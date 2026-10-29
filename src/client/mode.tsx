/**
 * Where the session rows are listed, which decides what the main panel shows: the session view alone when
 * the Workspace browser lists the rows, or the page with its own list beside the view otherwise.
 * @module dsh-agent-bridge/client/mode
 */
import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** `browser`: the Workspace browser lists the rows. `page`: the plugin page lists them. */
export type ListMode = 'browser' | 'page'

/** Observable list mode. */
export interface ModeStore extends HostObservable<ListMode> {
  set(next: ListMode): void
}

/**
 * Create a mode store.
 * @param initial - starting mode.
 * @returns the store.
 */
export function createModeStore(initial: ListMode): ModeStore {
  let mode = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => mode,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (next === mode) return
      mode = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Main panel component that follows the mode.
 * @param mode - list mode store.
 * @param inBrowser - component shown while the browser lists the rows.
 * @param onPage - component shown while the page lists them.
 * @returns the switching component.
 */
export function withMode<A extends object, B extends object>(
  mode: ModeStore,
  inBrowser: (props: A) => ReactNode,
  onPage: (props: B) => ReactNode,
): (props: A & B) => ReactNode {
  return function ModePanel(props: A & B): ReactNode {
    const current = useSyncExternalStore(mode.subscribe, mode.getSnapshot)
    return current === 'browser' ? createElement(inBrowser, props) : createElement(onPage, props)
  }
}
