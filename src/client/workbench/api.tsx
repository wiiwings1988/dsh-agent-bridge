/** Shared helpers of the workbench tabs. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../ToolCard.tsx'
import css from './Workbench.module.css'

/** Props every tab receives. */
export interface TabProps { readonly cwd: string; readonly active: boolean; readonly t: Translate }

/** GET with a query, or POST with a JSON body; throws the server's error text. */
export async function call<T>(path: string, init?: { query?: Record<string, string>; body?: unknown }): Promise<T> {
  const query = init?.query === undefined ? '' : `?${new URLSearchParams(init.query).toString()}`
  const response = await fetch(`${path}${query}`, {
    credentials: 'same-origin',
    ...init?.body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

/** @returns the text of any thrown value. */
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** A button that asks once more before running a destructive or outward action. */
export function ConfirmButton({ label, confirmLabel, cancelLabel, onConfirm, testId, disabled }: {
  label: ReactNode; confirmLabel: ReactNode; cancelLabel: ReactNode; onConfirm: () => void; testId: string; disabled?: boolean
}) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <Button variant="ghost" size="sm" data-testid={testId} disabled={disabled === true} onClick={() => { setAsking(true) }}>{label}</Button>
  return (
    <span className={css.confirm}>
      <Button variant="primary" size="sm" data-testid={`${testId}-confirm`} onClick={() => { setAsking(false); onConfirm() }}>{confirmLabel}</Button>
      <Button variant="ghost" size="sm" data-testid={`${testId}-cancel`} onClick={() => { setAsking(false) }}>{cancelLabel}</Button>
    </span>
  )
}

/** A button that reveals a one-line input and runs `onSubmit` with the typed text. */
export function PromptButton({ label, placeholder, submitLabel, initial, onSubmit, testId }: {
  label: ReactNode; placeholder: string; submitLabel: ReactNode; initial?: string; onSubmit: (text: string) => void; testId: string
}) {
  const [text, setText] = useState<string | undefined>(undefined)
  if (text === undefined) return <Button variant="ghost" size="sm" data-testid={testId} onClick={() => { setText(initial ?? '') }}>{label}</Button>
  const submit = (): void => { const value = text.trim(); if (value !== '') { setText(undefined); onSubmit(value) } }
  return (
    <span className={css.confirm}>
      <input
        data-testid={`${testId}-input`} value={text} placeholder={placeholder} autoFocus
        onChange={(event) => { setText(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); if (event.key === 'Escape') setText(undefined) }}
      />
      <Button variant="primary" size="sm" data-testid={`${testId}-submit`} disabled={text.trim() === ''} onClick={submit}>{submitLabel}</Button>
    </span>
  )
}
