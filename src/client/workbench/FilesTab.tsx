/** File tree and editor of the session directory. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  FS_ACTION_PATH, FS_IMAGE_PATH, FS_LIST_PATH, FS_READ_PATH, FS_WRITE_PATH,
  type FsActionWire, type FsEntryWire, type FsFileWire, type FsImageWire,
} from '../../protocol.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { call, ConfirmButton, message, PromptButton, type TabProps } from './api.tsx'
import css from './Workbench.module.css'

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i
const join = (dir: string, name: string): string => dir === '.' ? name : `${dir}/${name}`
const parentOf = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'

interface Selected { readonly path: string; readonly dir: boolean }

function TreeNode({ cwd, path, name, depth, onOpen, onSelect, selected, reload }: {
  cwd: string; path: string; name: string; depth: number; onOpen: (path: string) => void; onSelect: (item: Selected) => void
  selected: Selected | undefined; reload: number
}) {
  const [open, setOpen] = useState(depth === 0)
  const [entries, setEntries] = useState<FsEntryWire[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    void call<{ entries: FsEntryWire[] }>(FS_LIST_PATH, { query: { cwd, path } }).then(body => { setEntries(body.entries); setError(undefined) }, (reason: unknown) => { setError(message(reason)) })
  }, [open, cwd, path, reload])
  const isSelected = (candidate: string): boolean => selected?.path === candidate
  return (
    <li role="treeitem" aria-expanded={open}>
      {depth > 0 && (
        <button
          type="button" className={`${css.node} ${isSelected(path) ? css.nodeOpen : ''}`} data-testid="wb-dir" data-path={path} style={{ paddingLeft: depth * 12 }}
          onClick={() => { setOpen(value => !value); onSelect({ path, dir: true }) }}
        >{open ? '▾' : '▸'} {name}</button>
      )}
      {error !== undefined && <p className={css.error}>{error}</p>}
      {open && entries !== undefined && (
        <ul role="group" className={css.tree}>
          {entries.map(entry => entry.dir
            ? <TreeNode key={entry.name} cwd={cwd} path={join(path, entry.name)} name={entry.name} depth={depth + 1} onOpen={onOpen} onSelect={onSelect} selected={selected} reload={reload} />
            : (
              <li key={entry.name}>
                <button
                  type="button" className={`${css.node} ${isSelected(join(path, entry.name)) ? css.nodeOpen : ''}`} data-testid="wb-file" data-path={join(path, entry.name)}
                  style={{ paddingLeft: (depth + 1) * 12 }} onClick={() => { onOpen(join(path, entry.name)) }}
                >{entry.name}</button>
              </li>
            ))}
        </ul>
      )}
    </li>
  )
}

type Opened =
  | { readonly kind: 'text'; readonly path: string; readonly base: FsFileWire; readonly text: string; readonly generation: number }
  | { readonly kind: 'image'; readonly path: string; readonly image: FsImageWire }

/** File tree with file management and a highlighted editor. */
export function FilesTab({ cwd, active, t }: TabProps) {
  const [file, setFile] = useState<Opened | undefined>(undefined)
  const [selected, setSelected] = useState<Selected | undefined>(undefined)
  const [status, setStatus] = useState<{ kind: 'error' | 'saved'; text: string } | undefined>(undefined)
  const [reload, setReload] = useState(0)
  const upload = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  useEffect(() => { setFile(undefined); setSelected(undefined); setStatus(undefined) }, [cwd])
  useEffect(() => { if (active) setReload(n => n + 1) }, [active])
  const dirty = file?.kind === 'text' && file.text !== file.base.content
  const open = useCallback((path: string): void => {
    setSelected({ path, dir: false })
    if (IMAGE.test(path)) {
      void call<FsImageWire>(FS_IMAGE_PATH, { query: { cwd, path } }).then(
        (image) => { setFile({ kind: 'image', path, image }); setStatus(undefined) },
        (reason: unknown) => { setStatus({ kind: 'error', text: message(reason) }) })
      return
    }
    void call<FsFileWire>(FS_READ_PATH, { query: { cwd, path } }).then(
      (base) => { generation.current += 1; setFile({ kind: 'text', path, base, text: base.content, generation: generation.current }); setStatus(undefined) },
      (reason: unknown) => { setStatus({ kind: 'error', text: message(reason) }) },
    )
  }, [cwd])
  const save = (): void => {
    if (file?.kind !== 'text' || !dirty) return
    void call<{ mtimeMs: number }>(FS_WRITE_PATH, { body: { cwd, path: file.path, content: file.text, baseMtimeMs: file.base.mtimeMs } }).then(
      ({ mtimeMs }) => { setFile({ ...file, base: { content: file.text, mtimeMs } }); setStatus({ kind: 'saved', text: t('wb.files.saved') }) },
      (reason: unknown) => { setStatus({ kind: 'error', text: message(reason) }) },
    )
  }
  const act = (body: FsActionWire, after?: () => void): void => {
    void call(FS_ACTION_PATH, { body }).then(() => { setReload(n => n + 1); setStatus(undefined); after?.() }, (reason: unknown) => { setStatus({ kind: 'error', text: message(reason) }) })
  }
  const targetDir = selected === undefined ? '.' : selected.dir ? selected.path : parentOf(selected.path)
  const onUpload = (files: FileList | null): void => {
    for (const item of Array.from(files ?? [])) {
      void item.arrayBuffer().then((buffer) => {
        let binary = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        act({ cwd, action: 'upload', path: targetDir, name: item.name, base64: btoa(binary) })
      })
    }
  }
  return (
    <div className={css.files} data-testid="wb-files">
      <div className={css.treeCol}>
        <div className={css.fileTools}>
          <PromptButton testId="wb-new-file" label={t('wb.files.newFile')} placeholder={t('wb.files.name')} submitLabel={t('wb.files.create')}
            onSubmit={(name) => { act({ cwd, action: 'create', path: join(targetDir, name), kind: 'file' }, () => { open(join(targetDir, name)) }) }} />
          <PromptButton testId="wb-new-dir" label={t('wb.files.newDir')} placeholder={t('wb.files.name')} submitLabel={t('wb.files.create')}
            onSubmit={(name) => { act({ cwd, action: 'create', path: join(targetDir, name), kind: 'dir' }) }} />
          <Button variant="ghost" size="sm" data-testid="wb-upload" onClick={() => { upload.current?.click() }}>{t('wb.files.upload')}</Button>
          <input ref={upload} type="file" multiple hidden data-testid="wb-upload-input" onChange={(event) => { onUpload(event.target.files); event.target.value = '' }} />
          {selected !== undefined && (
            <>
              <PromptButton testId="wb-rename" label={t('wb.files.rename')} placeholder={t('wb.files.name')} submitLabel={t('wb.files.rename')} initial={selected.path}
                onSubmit={(to) => { act({ cwd, action: 'rename', path: selected.path, to }, () => { setSelected({ path: to, dir: selected.dir }); setFile(undefined) }) }} />
              <ConfirmButton testId="wb-delete" label={t('wb.files.delete')} confirmLabel={t('wb.files.confirmDelete', { name: selected.path })} cancelLabel={t('manage.cancel')}
                onConfirm={() => { act({ cwd, action: 'delete', path: selected.path }, () => { setSelected(undefined); setFile(undefined) }) }} />
            </>
          )}
        </div>
        <ul role="tree" className={css.treeRoot}>
          <TreeNode cwd={cwd} path="." name="" depth={0} onOpen={open} onSelect={setSelected} selected={selected} reload={reload} />
        </ul>
      </div>
      <div className={css.editor}>
        {file === undefined && <p className={css.notice}>{t('wb.files.pick')}</p>}
        {file?.kind === 'image' && (
          <>
            <div className={css.editorBar}><span className={css.path} data-testid="wb-file-path">{file.path}</span></div>
            <div className={css.imagePane}><img data-testid="wb-image" alt={file.path} src={`data:${file.image.mime};base64,${file.image.base64}`} /></div>
          </>
        )}
        {file?.kind === 'text' && (
          <>
            <div className={css.editorBar}>
              <span className={css.path} data-testid="wb-file-path">{file.path}{dirty ? ' ●' : ''}</span>
              <Button variant="primary" size="sm" data-testid="wb-save" disabled={!dirty} onClick={save}>{t('wb.files.save')}</Button>
              <Button variant="ghost" size="sm" data-testid="wb-reload" onClick={() => { open(file.path) }}>{t('wb.files.reload')}</Button>
            </div>
            <CodeEditor
              docKey={`${file.path}#${file.generation}`} path={file.path} initial={file.text} onSave={save}
              onChange={(text) => { setFile(current => current?.kind === 'text' ? { ...current, text } : current) }}
            />
          </>
        )}
        {status !== undefined && <p className={status.kind === 'error' ? css.error : css.notice} role="status" data-testid="wb-file-status">{status.text}</p>}
      </div>
    </div>
  )
}
