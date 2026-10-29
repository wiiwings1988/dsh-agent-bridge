/**
 * Outline icons drawn by this plugin, so the panel does not depend on the icon names a given dsh
 * release exports from ui-primitives. Every icon is a 16-unit stroke drawing in `currentColor`.
 * @module dsh-agent-bridge/icons
 */
import type { ReactNode } from 'react'

function outline(paths: readonly string[]) {
  return function Icon({ size = 16 }: { size?: number }): ReactNode {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {paths.map(d => <path key={d} d={d} />)}
      </svg>
    )
  }
}

/** Plus sign (attach, new session). */
export const IconPlus = outline(['M8 3v10', 'M3 8h10'])
/** Magnifier (search). */
export const IconSearch = outline(['M7 12.2a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4Z', 'm10.8 10.8 3.4 3.4'])
/** Pencil (rename). */
export const IconEdit = outline(['M10.6 2.6a1.6 1.6 0 0 1 2.3 2.3L5.6 12.2 2.5 13l.8-3.1 7.3-7.3Z', 'm9.4 3.8 2.3 2.3'])
/** Branch (fork). */
export const IconBranch = outline(['M4.5 2.5v11', 'M4.5 13.5a1.5 1.5 0 1 0 0-.01', 'M11.5 5.5a1.5 1.5 0 1 0 0-.01', 'M11.5 5.5c0 3-7 3-7 6'])
/** Box with a lid (archive). */
export const IconArchive = outline(['M2.5 3h11v3h-11z', 'M3.5 6v7h9V6', 'M6.5 8.5h3'])
/** Bin (delete). */
export const IconTrash = outline(['M2.5 4h11', 'M6 4V2.5h4V4', 'M3.8 4l.7 9.5h7l.7-9.5', 'M6.6 6.5v4.5', 'M9.4 6.5v4.5'])
/** Alarm clock (scheduled send). */
export const IconAlarm = outline(['M8 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z', 'M8 5.8V8.5l1.8 1.2', 'M2.3 3.8 4 2.2', 'M13.7 3.8 12 2.2'])
/** Two speech bubbles (the Claude / Codex sessions page). */
export const IconChats = outline(['M2.5 3.5h7.5a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1H6l-2.5 2V10h-1a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z', 'M11 6h2.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-1V14L10 12.5H7.5'])
/** Three dots (more actions). */
export const IconMore = outline(['M3.2 8h.6', 'M7.7 8h.6', 'M12.2 8h.6'])
/** Two sheets (copy). */
export const IconCopy = outline(['M5.5 5.5h7v8h-7z', 'M3.5 10.5v-8h7'])
/** Microphone (dictate). */
export const IconMic = outline(['M8 10.5a2.5 2.5 0 0 0 2.5-2.5V4a2.5 2.5 0 0 0-5 0v4A2.5 2.5 0 0 0 8 10.5Z', 'M3.5 7.5a4.5 4.5 0 0 0 9 0', 'M8 12v2'])
/** Speaker (read aloud). */
export const IconSpeaker = outline(['M2.5 6h2.5l3.5-3v10L5 10H2.5z', 'M11 5.5a3.5 3.5 0 0 1 0 5', 'M12.8 3.8a6 6 0 0 1 0 8.4'])
