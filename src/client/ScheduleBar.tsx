/** Send a message to this session later; shows what is queued. */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { SCHEDULE_PATH, type ScheduleBodyWire, type ScheduledWire } from '../protocol.ts'
import type { Choice } from './ComposerBar.tsx'
import type { Translate } from './ToolCard.tsx'
import { call, message } from './workbench/api.tsx'
import css from './ExternalPanel.module.css'

const local = (ms: number): string => {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 19)
}

/**
 * Queue of one session's scheduled messages and, while open, the time picker; the toggle sits in the composer toolbar.
 * @param props.open - whether the time picker is shown.
 * @param props.onClose - hides the time picker.
 */
export function ScheduleBar({ sessionId, cwd, text, choice, open, onClose, onSent, t }: {
  sessionId: string; cwd: string; text: string; choice: Choice; open: boolean; onClose: () => void; onSent: () => void; t: Translate
}) {
  const [items, setItems] = useState<ScheduledWire[]>([])
  const [at, setAt] = useState(() => local(Date.now() + 3_600_000))
  useEffect(() => { if (open) setAt(local(Date.now() + 3_600_000)) }, [open])
  const [error, setError] = useState<string | undefined>(undefined)
  const load = useCallback((): void => {
    void call<{ messages: ScheduledWire[] }>(SCHEDULE_PATH, { query: { id: sessionId } }).then(({ messages }) => { setItems(messages) }, () => {})
  }, [sessionId])
  useEffect(() => {
    load()
    const timer = window.setInterval(load, 4000)
    return () => { window.clearInterval(timer) }
  }, [load])
  const add = (): void => {
    const body: ScheduleBodyWire = {
      action: 'add', sessionId, cwd, text: text.trim(), at: new Date(at).getTime(),
      ...choice.model === '' ? {} : { model: choice.model }, ...choice.effort === '' ? {} : { effort: choice.effort },
    }
    void call(SCHEDULE_PATH, { body }).then(() => { onClose(); setError(undefined); onSent(); load() }, (reason: unknown) => { setError(message(reason)) })
  }
  return (
    <div className={css.schedule} data-testid="ext-schedule-bar">
      {items.length > 0 && (
        <ul className={css.scheduled}>
          {items.map(item => (
            <li key={item.id} data-testid="ext-scheduled-item" data-status={item.status}>
              <span className={css.meta}>{new Date(item.at).toLocaleString()} · {t(`schedule.${item.status}`)}{item.error === undefined ? '' : ` (${item.error})`}</span>
              {' '}{item.text.slice(0, 80)}
              {item.status === 'pending' && (
                <Button variant="ghost" size="sm" data-testid="ext-schedule-cancel" onClick={() => { void call(SCHEDULE_PATH, { body: { action: 'cancel', id: item.id } satisfies ScheduleBodyWire }).then(load) }}>{t('manage.cancel')}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className={css.row}>
          <input type="datetime-local" step="1" data-testid="ext-schedule-at" value={at} onChange={(event) => { setAt(event.target.value) }} />
          <Button variant="primary" size="sm" data-testid="ext-schedule-add" disabled={text.trim() === ''} onClick={add}>{t('schedule.confirm')}</Button>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('manage.cancel')}</Button>
          {text.trim() === '' && <span className={css.meta}>{t('schedule.needText')}</span>}
          {error !== undefined && <span className={css.error} role="alert" data-testid="ext-schedule-error">{error}</span>}
        </div>
      )}
    </div>
  )
}
