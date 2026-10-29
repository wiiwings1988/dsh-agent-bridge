/** Git: status, staging, commit, history, branches and remote. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  GIT_ACTION_PATH, GIT_BRANCHES_PATH, GIT_WORKTREES_PATH, type WorktreeBodyWire, type WorktreeWire, GIT_COMPARE_PATH, GIT_DIFF_PATH, GIT_LOG_PATH, GIT_MESSAGE_PATH, GIT_REMOTE_PATH, GIT_SHOW_PATH, GIT_STATUS_PATH,
  type GitActionWire, type GitCommitWire, type GitRangeDiffWire, type GitRemoteWire, type GitStatusWire,
} from '../../protocol.ts'
import { DiffText } from '../ToolCard.tsx'
import { call, ConfirmButton, message, type TabProps } from './api.tsx'
import css from './Workbench.module.css'

const LETTER: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', '?': 'U', U: '!' }

/** Git tab. */
export function GitTab({ cwd, active, t }: TabProps) {
  const [status, setStatus] = useState<GitStatusWire | undefined>(undefined)
  const [branches, setBranches] = useState<{ current: string; branches: string[] } | undefined>(undefined)
  const [remote, setRemote] = useState<GitRemoteWire | undefined>(undefined)
  const [commits, setCommits] = useState<GitCommitWire[]>([])
  const [diff, setDiff] = useState<{ title: string; text: string; files?: readonly string[] } | undefined>(undefined)
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [compare, setCompare] = useState<{ base: string; head: string }>({ base: '', head: '' })
  const [worktrees, setWorktrees] = useState<WorktreeWire[]>([])
  const [newTree, setNewTree] = useState('')
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await call<GitStatusWire>(GIT_STATUS_PATH, { query: { cwd } })
      setStatus(next)
      setError(undefined)
      if (next.isRepo) {
        const [branchList, remoteState, log] = await Promise.all([
          call<{ current: string; branches: string[] }>(GIT_BRANCHES_PATH, { query: { cwd } }),
          call<GitRemoteWire>(GIT_REMOTE_PATH, { query: { cwd } }),
          call<{ commits: GitCommitWire[] }>(GIT_LOG_PATH, { query: { cwd } }),
        ])
        setBranches(branchList)
        setRemote(remoteState)
        setCommits(log.commits)
        setWorktrees((await call<{ worktrees: WorktreeWire[] }>(GIT_WORKTREES_PATH, { query: { cwd } })).worktrees)
        setCompare(current => ({ base: current.base === '' ? branchList.branches.find(name => name !== branchList.current) ?? branchList.current : current.base, head: current.head === '' ? branchList.current : current.head }))
      }
    } catch (reason) { setError(message(reason)) }
  }, [cwd])
  useEffect(() => { setDiff(undefined); setStatus(undefined); setCompare({ base: '', head: '' }) }, [cwd])
  useEffect(() => { if (active) void refresh() }, [active, refresh])
  const act = async (body: GitActionWire): Promise<boolean> => {
    setBusy(body.action)
    try { await call(GIT_ACTION_PATH, { body }); await refresh(); return true } catch (reason) { setError(message(reason)); return false } finally { setBusy(undefined) }
  }
  const show = (path: string, staged: boolean, untracked: boolean): void => {
    void call<{ diff: string }>(GIT_DIFF_PATH, { query: { cwd, path, staged: staged ? '1' : '0', untracked: untracked ? '1' : '0' } }).then(
      ({ diff: text }) => { setDiff({ title: path, text }) }, (reason: unknown) => { setError(message(reason)) })
  }
  const showRange = (title: string, path: string, query: Record<string, string>): void => {
    void call<GitRangeDiffWire>(path, { query: { cwd, ...query } }).then(
      ({ diff: text, files }) => { setDiff({ title, text, files }) }, (reason: unknown) => { setError(message(reason)) })
  }
  if (status !== undefined && !status.isRepo) {
    return (
      <div className={css.git} data-testid="wb-git">
        <p className={css.notice}>{t('wb.git.notRepo')}</p>
        <div><Button variant="primary" size="sm" data-testid="wb-git-init" onClick={() => { void act({ cwd, action: 'init' }) }}>{t('wb.git.init')}</Button></div>
        {error !== undefined && <p className={css.error} role="alert" data-testid="wb-git-error">{error}</p>}
      </div>
    )
  }
  const staged = status?.changes.filter(c => c.index !== ' ' && c.index !== '?') ?? []
  const unstaged = status?.changes.filter(c => c.worktree !== ' ') ?? []
  const row = (change: { path: string; index: string; worktree: string }, isStaged: boolean): ReactNode => {
    const letter = isStaged ? change.index : change.worktree
    return (
      <li key={`${isStaged ? 's' : 'u'}:${change.path}`} className={css.change} data-testid={isStaged ? 'wb-staged' : 'wb-unstaged'} data-path={change.path}>
        <span className={css.letter} data-letter={LETTER[letter] ?? letter}>{LETTER[letter] ?? letter}</span>
        <button type="button" className={css.changePath} data-testid="wb-change-path" onClick={() => { show(change.path, isStaged, change.index === '?') }}>{change.path}</button>
        <Button variant="ghost" size="sm" data-testid={isStaged ? 'wb-unstage' : 'wb-stage'} onClick={() => { void act({ cwd, action: isStaged ? 'unstage' : 'stage', paths: [change.path] }) }}>
          {isStaged ? t('wb.git.unstage') : t('wb.git.stage')}
        </Button>
        {!isStaged && (
          <ConfirmButton testId="wb-discard" label={t('wb.git.discard')} confirmLabel={t('wb.git.confirmDiscard')} cancelLabel={t('manage.cancel')}
            onConfirm={() => { void act({ cwd, action: 'discard', paths: [change.path] }) }} />
        )}
      </li>
    )
  }
  const hasRemote = (remote?.remotes.length ?? 0) > 0
  return (
    <div className={css.git} data-testid="wb-git">
      <div className={css.gitBar}>
        <label>{t('wb.git.branch')}{' '}
          <select data-testid="wb-branch" value={branches?.current ?? ''} onChange={(event) => { void act({ cwd, action: 'checkout', branch: event.target.value }) }}>
            {(branches?.branches ?? []).map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <input data-testid="wb-new-branch" value={newBranch} placeholder={t('wb.git.newBranch')} onChange={(event) => { setNewBranch(event.target.value) }} />
        <Button variant="outline" size="sm" data-testid="wb-create-branch" disabled={newBranch.trim() === ''}
          onClick={() => { void act({ cwd, action: 'checkout', branch: newBranch.trim(), create: true }).then((ok) => { if (ok) setNewBranch('') }) }}>{t('wb.git.create')}</Button>
        <Button variant="ghost" size="sm" data-testid="wb-git-refresh" onClick={() => { void refresh() }}>{t('wb.git.refresh')}</Button>
      </div>
      <div className={css.gitBar} data-testid="wb-remote">
        <span className={css.notice} data-testid="wb-sync" data-ahead={remote?.ahead ?? 0} data-behind={remote?.behind ?? 0}>
          {remote?.upstream === undefined ? (hasRemote ? t('wb.git.noUpstream') : t('wb.git.noRemote')) : `${remote.upstream} · ↑${remote.ahead} ↓${remote.behind}`}
        </span>
        <Button variant="ghost" size="sm" data-testid="wb-fetch" disabled={!hasRemote || busy !== undefined} onClick={() => { void act({ cwd, action: 'fetch' }) }}>{t('wb.git.fetch')}</Button>
        <Button variant="ghost" size="sm" data-testid="wb-pull" disabled={remote?.upstream === undefined || busy !== undefined} onClick={() => { void act({ cwd, action: 'pull' }) }}>{t('wb.git.pull')}</Button>
        {remote?.upstream !== undefined && (
          <ConfirmButton testId="wb-push" label={t('wb.git.push')} confirmLabel={t('wb.git.confirmPush', { n: remote.ahead })} cancelLabel={t('manage.cancel')} disabled={remote.ahead === 0 || busy !== undefined}
            onConfirm={() => { void act({ cwd, action: 'push' }) }} />
        )}
        {remote?.upstream === undefined && hasRemote && (
          <ConfirmButton testId="wb-publish" label={t('wb.git.publish')} confirmLabel={t('wb.git.confirmPublish', { branch: branches?.current ?? '' })} cancelLabel={t('manage.cancel')}
            onConfirm={() => { void act({ cwd, action: 'publish' }) }} />
        )}
        {busy !== undefined && <span className={css.notice}>{busy}…</span>}
      </div>
      {error !== undefined && <p className={css.error} role="alert" data-testid="wb-git-error">{error}</p>}
      <div className={css.gitCols}>
        <div>
          <h3>{t('wb.git.staged')} ({staged.length})</h3>
          <ul className={css.changes}>{staged.map(change => row(change, true))}</ul>
          <h3>{t('wb.git.changes')} ({unstaged.length})
            {unstaged.length > 0 && <Button variant="ghost" size="sm" data-testid="wb-stage-all" onClick={() => { void act({ cwd, action: 'stage', paths: unstaged.map(change => change.path) }) }}>{t('wb.git.stageAll')}</Button>}
          </h3>
          <ul className={css.changes}>{unstaged.map(change => row(change, false))}</ul>
          {staged.length === 0 && unstaged.length === 0 && status !== undefined && <p className={css.notice}>{t('wb.git.clean')}</p>}
          <textarea className={css.commitBox} data-testid="wb-commit-message" rows={3} value={commitMessage} placeholder={t('wb.git.message')} onChange={(event) => { setCommitMessage(event.target.value) }} />
          <div className={css.row}>
            <Button variant="primary" size="sm" data-testid="wb-commit" disabled={staged.length === 0 || commitMessage.trim() === ''}
              onClick={() => { void act({ cwd, action: 'commit', message: commitMessage.trim() }).then((ok) => { if (ok) setCommitMessage('') }) }}>{t('wb.git.commit')}</Button>
            <Button variant="outline" size="sm" data-testid="wb-draft-message" disabled={staged.length === 0 || busy !== undefined}
              onClick={() => {
                setBusy('draft')
                void call<{ message: string }>(GIT_MESSAGE_PATH, { query: { cwd } }).then(({ message: text }) => { setCommitMessage(text) }, (reason: unknown) => { setError(message(reason)) }).finally(() => { setBusy(undefined) })
              }}>{t('wb.git.draft')}</Button>
            {commits.length === 0 && (status?.changes.length ?? 0) > 0 && (
              <Button variant="outline" size="sm" data-testid="wb-initial-commit" onClick={() => { void act({ cwd, action: 'initialCommit' }) }}>{t('wb.git.initialCommit')}</Button>
            )}
          </div>
        </div>
        <div>
          {diff !== undefined && (
            <>
              <h3 data-testid="wb-diff-path">{diff.title}</h3>
              {diff.files !== undefined && <p className={css.notice} data-testid="wb-diff-files">{diff.files.join(', ')}</p>}
              <div data-testid="wb-diff"><DiffText text={diff.text === '' ? t('wb.git.noDiff') : diff.text} /></div>
            </>
          )}
          <h3>{t('wb.git.compare')}</h3>
          <div className={css.row}>
            <select data-testid="wb-compare-base" value={compare.base} onChange={(event) => { setCompare({ ...compare, base: event.target.value }) }}>{(branches?.branches ?? []).map(name => <option key={name} value={name}>{name}</option>)}</select>
            <span>…</span>
            <select data-testid="wb-compare-head" value={compare.head} onChange={(event) => { setCompare({ ...compare, head: event.target.value }) }}>{(branches?.branches ?? []).map(name => <option key={name} value={name}>{name}</option>)}</select>
            <Button variant="outline" size="sm" data-testid="wb-compare" onClick={() => { showRange(`${compare.base}...${compare.head}`, GIT_COMPARE_PATH, { base: compare.base, head: compare.head }) }}>{t('wb.git.show')}</Button>
            {compare.base !== '' && compare.base !== branches?.current && (
              <ConfirmButton testId="wb-delete-branch" label={t('wb.git.deleteNamed', { name: compare.base })} confirmLabel={t('wb.git.confirmDeleteBranch', { name: compare.base })} cancelLabel={t('manage.cancel')}
                onConfirm={() => { void act({ cwd, action: 'deleteBranch', branch: compare.base }) }} />
            )}
          </div>
          <h3>{t('wb.git.worktrees')}</h3>
          <ul className={css.rows} data-testid="wb-worktrees">
            {worktrees.map(tree => (
              <li key={tree.path} data-testid="wb-worktree" data-branch={tree.branch} data-main={tree.main}>
                <code>{tree.branch === '' ? tree.head : tree.branch}</code> <span className={css.notice}>{tree.path}</span>
                <Button variant="ghost" size="sm" data-testid="wb-worktree-open" onClick={() => { window.dispatchEvent(new CustomEvent('agent-bridge:new-session', { detail: { cwd: tree.path } })) }}>{t('wb.git.openSession')}</Button>
                {!tree.main && (
                  <>
                    <ConfirmButton testId="wb-worktree-merge" label={t('wb.git.merge')} confirmLabel={t('wb.git.confirmMerge', { branch: tree.branch })} cancelLabel={t('manage.cancel')}
                      onConfirm={() => { void call(GIT_WORKTREES_PATH, { body: { cwd, action: 'merge', branch: tree.branch } satisfies WorktreeBodyWire }).then(refresh, (reason: unknown) => { setError(message(reason)) }) }} />
                    <ConfirmButton testId="wb-worktree-remove" label={t('ext.remove')} confirmLabel={t('ext.confirmRemove', { name: tree.branch })} cancelLabel={t('manage.cancel')}
                      onConfirm={() => { void call(GIT_WORKTREES_PATH, { body: { cwd, action: 'remove', path: tree.path } satisfies WorktreeBodyWire }).then(refresh, (reason: unknown) => { setError(message(reason)) }) }} />
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className={css.row}>
            <input data-testid="wb-worktree-name" placeholder={t('wb.git.newBranch')} value={newTree} onChange={(event) => { setNewTree(event.target.value) }} />
            <Button variant="outline" size="sm" data-testid="wb-worktree-create" disabled={newTree.trim() === ''}
              onClick={() => { void call(GIT_WORKTREES_PATH, { body: { cwd, action: 'create', branch: newTree.trim() } satisfies WorktreeBodyWire }).then(() => { setNewTree(''); return refresh() }, (reason: unknown) => { setError(message(reason)) }) }}>{t('wb.git.createWorktree')}</Button>
          </div>
          <h3>{t('wb.git.log')}
            {commits.length > 0 && (
              <ConfirmButton testId="wb-undo-commit" label={t('wb.git.undoCommit')} confirmLabel={t('wb.git.confirmUndo')} cancelLabel={t('manage.cancel')}
                onConfirm={() => { void act({ cwd, action: 'undoLastCommit' }) }} />
            )}
          </h3>
          <ul className={css.log}>
            {commits.map(commit => (
              <li key={commit.hash} data-testid="wb-commit-row">
                <button type="button" className={css.changePath} onClick={() => { showRange(`${commit.hash.slice(0, 7)} ${commit.subject}`, GIT_SHOW_PATH, { hash: commit.hash }) }}>
                  <code>{commit.hash.slice(0, 7)}</code> {commit.subject} <span className={css.notice}>— {commit.author}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
