/** TaskMaster: tasks with status control, PRD files, and the model-backed actions. */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { TASKS_PATH, type TasksBodyWire, type TasksWire, type TaskWire } from '../../protocol.ts'
import { call, ConfirmButton, message, type TabProps } from './api.tsx'
import css from './Workbench.module.css'

const STATUSES = ['pending', 'in-progress', 'review', 'done', 'deferred', 'cancelled', 'blocked']

/** Tasks tab. */
export function TasksTab({ cwd, active, t }: TabProps) {
  const [data, setData] = useState<TasksWire | undefined>(undefined)
  const [tag, setTag] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [output, setOutput] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [editing, setEditing] = useState<{ file: string; content: string } | undefined>(undefined)
  const [newPrd, setNewPrd] = useState('')
  const load = useCallback((): void => {
    void call<TasksWire>(TASKS_PATH, { query: { cwd, ...tag === undefined ? {} : { tag } } }).then((next) => { setData(next); setError(undefined) }, (reason: unknown) => { setError(message(reason)) })
  }, [cwd, tag])
  useEffect(() => { if (active) load() }, [active, load])
  const act = (body: TasksBodyWire, after?: (result: { content?: string; output?: string }) => void): void => {
    setBusy(true)
    setError(undefined)
    void call<{ content?: string; output?: string }>(TASKS_PATH, { body })
      .then((result) => { if (result.output !== undefined) setOutput(result.output); after?.(result); load() }, (reason: unknown) => { setError(message(reason)) })
      .finally(() => { setBusy(false) })
  }
  const row = (task: TaskWire, depth: number): JSX.Element => (
    <li key={task.id} data-testid="tm-task" data-id={task.id} data-status={task.status} style={{ paddingLeft: depth * 16 }}>
      <span className={css.letter}>{task.id}</span>
      <span className={css.changePath}>{task.title}{task.dependencies.length > 0 && <small className={css.notice}> ← {task.dependencies.join(', ')}</small>}</span>
      <select data-testid="tm-status" value={task.status} onChange={(event) => { act({ cwd, action: 'status', id: task.id, status: event.target.value, ...tag === undefined ? {} : { tag } }) }}>
        {[...new Set([...STATUSES, task.status])].map(status => <option key={status} value={status}>{status}</option>)}
      </select>
    </li>
  )
  const flat = (tasks: readonly TaskWire[], depth = 0): JSX.Element[] => tasks.flatMap(task => [row(task, depth), ...flat(task.subtasks, depth + 1)])
  const counts = data?.tasks.reduce<Record<string, number>>((all, task) => ({ ...all, [task.status]: (all[task.status] ?? 0) + 1 }), {}) ?? {}
  return (
    <div className={css.extensions} data-testid="wb-tasks">
      {error !== undefined && <p className={css.error} role="alert" data-testid="tm-error">{error}</p>}
      {data !== undefined && !data.initialized && (
        <div className={css.row}>
          <span className={css.notice}>{t('tm.notInitialized')}</span>
          <ConfirmButton testId="tm-init" label={t('tm.init')} confirmLabel={t('tm.confirmInit')} cancelLabel={t('manage.cancel')} disabled={busy} onConfirm={() => { act({ cwd, action: 'init' }) }} />
        </div>
      )}
      {data !== undefined && data.tags.length > 1 && (
        <label>{t('tm.tag')}{' '}
          <select data-testid="tm-tag" value={data.tag} onChange={(event) => { setTag(event.target.value) }}>{data.tags.map(name => <option key={name} value={name}>{name}</option>)}</select>
        </label>
      )}
      {data !== undefined && data.tasks.length > 0 && (
        <p className={css.notice} data-testid="tm-counts">{Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(' · ')}</p>
      )}
      <ul className={css.rows} data-testid="tm-list">{flat(data?.tasks ?? [])}</ul>
      {data?.initialized === true && data.tasks.length === 0 && <p className={css.notice}>{t('tm.empty')}</p>}
      <h3>{t('tm.addTask')}</h3>
      <div className={css.form}>
        <textarea data-testid="tm-prompt" rows={2} placeholder={t('tm.promptPlaceholder')} value={prompt} onChange={(event) => { setPrompt(event.target.value) }} />
        <ConfirmButton testId="tm-add" label={t('tm.addWithModel')} confirmLabel={t('tm.confirmModel')} cancelLabel={t('manage.cancel')} disabled={busy || prompt.trim() === ''}
          onConfirm={() => { act({ cwd, action: 'add', prompt: prompt.trim(), ...tag === undefined ? {} : { tag } }, () => { setPrompt('') }) }} />
      </div>
      <h3>PRD</h3>
      <ul className={css.rows} data-testid="tm-prds">
        {(data?.prds ?? []).map(file => (
          <li key={file} data-testid="tm-prd" data-file={file}>
            <button type="button" className={css.changePath} data-testid="tm-prd-open" onClick={() => { act({ cwd, action: 'prd-read', file }, (result) => { setEditing({ file, content: result.content ?? '' }) }) }}>{file}</button>
            <ConfirmButton testId="tm-parse" label={t('tm.parse')} confirmLabel={t('tm.confirmModel')} cancelLabel={t('manage.cancel')} disabled={busy}
              onConfirm={() => { act({ cwd, action: 'parse', file, ...tag === undefined ? {} : { tag } }) }} />
            <ConfirmButton testId="tm-prd-delete" label={t('wb.files.delete')} confirmLabel={t('wb.files.confirmDelete', { name: file })} cancelLabel={t('manage.cancel')}
              onConfirm={() => { act({ cwd, action: 'prd-delete', file }, () => { if (editing?.file === file) setEditing(undefined) }) }} />
          </li>
        ))}
      </ul>
      <div className={css.form}>
        <input data-testid="tm-prd-name" placeholder="plan.md" value={newPrd} onChange={(event) => { setNewPrd(event.target.value) }} />
        <Button variant="outline" size="sm" data-testid="tm-prd-create" disabled={newPrd.trim() === ''}
          onClick={() => { const file = newPrd.trim(); act({ cwd, action: 'prd-write', file, content: '' }, () => { setNewPrd(''); setEditing({ file, content: '' }) }) }}>{t('tm.newPrd')}</Button>
      </div>
      {editing !== undefined && (
        <div>
          <h3 data-testid="tm-prd-title">{editing.file}</h3>
          <textarea className={css.commitBox} data-testid="tm-prd-editor" rows={12} value={editing.content} onChange={(event) => { setEditing({ ...editing, content: event.target.value }) }} />
          <Button variant="primary" size="sm" data-testid="tm-prd-save" onClick={() => { act({ cwd, action: 'prd-write', file: editing.file, content: editing.content }) }}>{t('wb.files.save')}</Button>
        </div>
      )}
      {output !== undefined && <pre className={css.notice} data-testid="tm-output">{output}</pre>}
    </div>
  )
}
