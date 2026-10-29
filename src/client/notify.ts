/** Turn-end notifications: a session that was running and no longer is raises a browser notification when the page is not in front. */
const KEY = 'agent-bridge:notify'

/** @returns whether the user switched notifications on. */
export function notificationsOn(): boolean {
  try { return window.localStorage.getItem(KEY) === '1' } catch { return false }
}

/** Switch notifications on or off; turning on asks the browser for permission. */
export async function setNotifications(on: boolean): Promise<boolean> {
  try { window.localStorage.setItem(KEY, on ? '1' : '0') } catch { /* storage unavailable */ }
  if (!on) return false
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'default') await Notification.requestPermission()
  return Notification.permission === 'granted'
}

/**
 * Ids that were running before and are not now.
 * @param before - running ids of the previous look.
 * @param after - running ids now.
 * @returns the ids whose turn just ended.
 */
export function endedSince(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...before].filter(id => !after.has(id))
}

/** Raise one notification when the page is hidden or unfocused. */
export function notifyEnded(title: string, body: string): void {
  if (!notificationsOn() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  try { new Notification(title, { body }) } catch { /* some browsers refuse outside a service worker */ }
}
