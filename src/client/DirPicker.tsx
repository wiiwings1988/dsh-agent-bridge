/** Folder browser and repository cloner for choosing the working directory of a new session. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CLONE_PATH, FS_BROWSE_PATH, type FsBrowseWire } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import { call, message } from './workbench/api.tsx'
import css from './ExternalPanel.module.css'

/** Picker with a folder list and a "clone from address" form. */
export function DirPicker({ start, onPick, t }: { start: string; onPick: (path: string) => void; t: Translate }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<FsBrowseWire | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const go = (path: string): void => {
    void call<FsBrowseWire>(FS_BROWSE_PATH, { query: { path } }).then((next) => { setView(next); setError(undefined) }, (reason: unknown) => { setError(message(reason)) })
  }
  useEffect(() => { if (open && view === undefined) go(start) }, [open])
  if (!open) return <Button variant="ghost" size="sm" data-testid="ext-browse" onClick={() => { setOpen(true) }}>{t('dir.browse')}</Button>
  return (
    <div className={css.dirPicker} data-testid="ext-dirpicker">
      <div className={css.row}>
        <code data-testid="ext-dir-path">{view?.path ?? '…'}</code>
        {view?.parent !== undefined && <Button variant="ghost" size="sm" data-testid="ext-dir-up" onClick={() => { go(view.parent ?? '') }}>↑</Button>}
        <Button variant="primary" size="sm" data-testid="ext-dir-choose" disabled={view === undefined} onClick={() => { if (view !== undefined) { onPick(view.path); setOpen(false) } }}>{t('dir.choose')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false) }}>{t('manage.cancel')}</Button>
      </div>
      <ul className={css.dirList}>
        {view?.dirs.map(dir => (
          <li key={dir}><button type="button" data-testid="ext-dir-entry" onClick={() => { go(`${view.path}/${dir}`) }}>{dir}</button></li>
        ))}
      </ul>
      <div className={css.row}>
        <input data-testid="ext-clone-url" placeholder={t('dir.cloneUrl')} value={url} onChange={(event) => { setUrl(event.target.value) }} />
        <input data-testid="ext-clone-name" placeholder={t('dir.cloneName')} value={name} onChange={(event) => { setName(event.target.value) }} />
        <Button
          variant="outline" size="sm" data-testid="ext-clone" disabled={url.trim() === '' || name.trim() === '' || view === undefined || busy}
          onClick={() => {
            if (view === undefined) return
            setBusy(true)
            void call<{ path: string }>(CLONE_PATH, { body: { url: url.trim(), parent: view.path, name: name.trim() } })
              .then(({ path }) => { onPick(path); setOpen(false); setUrl(''); setName('') }, (reason: unknown) => { setError(message(reason)) })
              .finally(() => { setBusy(false) })
          }}
        >{busy ? '…' : t('dir.clone')}</Button>
      </div>
      {error !== undefined && <p className={css.error} role="alert" data-testid="ext-dir-error">{error}</p>}
    </div>
  )
}
