/** Account, MCP servers, skills and the git identity. */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { GIT_CONFIG_PATH, MCP_PATH, SKILLS_PATH, type McpBodyWire, type SkillBodyWire, type SkillWire } from '../../protocol.ts'
import { useInfo } from '../info.ts'
import { call, ConfirmButton, message, type TabProps } from './api.tsx'
import css from './Workbench.module.css'

/** Extensions tab. */
export function ExtensionsTab({ cwd, active, t, engine }: TabProps & { engine: 'claude' | 'codex' }) {
  const { info, error: infoError, reload } = useInfo(engine, active ? cwd : undefined)
  const [skills, setSkills] = useState<SkillWire[]>([])
  const [status, setStatus] = useState<{ kind: 'error' | 'ok'; text: string } | undefined>(undefined)
  const [server, setServer] = useState({ name: '', scope: 'user' as 'user' | 'project' | 'local', kind: 'stdio', command: '', args: '', url: '' })
  const [skill, setSkill] = useState({ name: '', scope: 'user' as 'user' | 'project', description: '', body: '' })
  const [identity, setIdentity] = useState({ name: '', email: '' })
  const loadSkills = useCallback((): void => {
    if (engine !== 'claude') return
    void call<{ skills: SkillWire[] }>(SKILLS_PATH, { query: { cwd } }).then(({ skills: list }) => { setSkills(list) }, () => {})
  }, [cwd, engine])
  useEffect(() => { if (active) { loadSkills(); void call<{ name: string; email: string }>(GIT_CONFIG_PATH).then(setIdentity, () => {}) } }, [active, loadSkills])
  const run = (work: Promise<unknown>, okText: string, after?: () => void): void => {
    setStatus(undefined)
    void work.then(() => { setStatus({ kind: 'ok', text: okText }); after?.() }, (reason: unknown) => { setStatus({ kind: 'error', text: message(reason) }) })
  }
  const addServer = (): void => {
    const config = server.kind === 'stdio'
      ? { type: 'stdio', command: server.command.trim(), args: server.args.trim() === '' ? [] : server.args.trim().split(/\s+/) }
      : { type: server.kind, url: server.url.trim() }
    const body: McpBodyWire = { cwd, action: 'add', name: server.name.trim(), scope: server.scope, config }
    run(call(MCP_PATH, { body }), t('ext.saved'), () => { setServer({ ...server, name: '', command: '', args: '', url: '' }); reload() })
  }
  return (
    <div className={css.extensions} data-testid="wb-extensions">
      {infoError !== undefined && <p className={css.error} role="alert">{infoError}</p>}
      <h3>{t('ext.account')}</h3>
      <p data-testid="ext-account">
        {info?.account === undefined ? t('ext.unknown')
          : info.account.loggedIn ? t('ext.loggedIn', { who: [info.account.email, info.account.plan, info.account.provider].filter(Boolean).join(' · ') || '—' })
            : t('ext.loggedOut')}
      </p>
      {engine === 'claude' && (
        <>
          <h3>{t('ext.mcp')}</h3>
          <ul className={css.rows} data-testid="ext-mcp-list">
            {(info?.mcp ?? []).map(item => (
              <li key={item.name} data-testid="ext-mcp-item" data-name={item.name} data-status={item.status}>
                <strong>{item.name}</strong> <span className={css.notice}>{item.status}{item.scope === undefined ? '' : ` · ${item.scope}`}{item.tools === undefined ? '' : ` · ${item.tools} tools`}{item.error === undefined ? '' : ` · ${item.error}`}</span>
                {(item.scope === 'user' || item.scope === 'project' || item.scope === 'local') && ((scope: 'user' | 'project' | 'local') => (
                  <ConfirmButton testId="ext-mcp-remove" label={t('ext.remove')} confirmLabel={t('ext.confirmRemove', { name: item.name })} cancelLabel={t('manage.cancel')}
                    onConfirm={() => { run(call(MCP_PATH, { body: { cwd, action: 'remove', name: item.name, scope } satisfies McpBodyWire }), t('ext.saved'), reload) }} />
                ))(item.scope)}
              </li>
            ))}
          </ul>
          <div className={css.form}>
            <input data-testid="ext-mcp-name" placeholder={t('ext.name')} value={server.name} onChange={(event) => { setServer({ ...server, name: event.target.value }) }} />
            <select data-testid="ext-mcp-scope" value={server.scope} onChange={(event) => { setServer({ ...server, scope: event.target.value as typeof server.scope }) }}>
              <option value="user">user</option><option value="project">project</option><option value="local">local</option>
            </select>
            <select data-testid="ext-mcp-kind" value={server.kind} onChange={(event) => { setServer({ ...server, kind: event.target.value }) }}>
              <option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option>
            </select>
            {server.kind === 'stdio'
              ? (
                <>
                  <input data-testid="ext-mcp-command" placeholder={t('ext.command')} value={server.command} onChange={(event) => { setServer({ ...server, command: event.target.value }) }} />
                  <input data-testid="ext-mcp-args" placeholder={t('ext.args')} value={server.args} onChange={(event) => { setServer({ ...server, args: event.target.value }) }} />
                </>
              )
              : <input data-testid="ext-mcp-url" placeholder="https://…" value={server.url} onChange={(event) => { setServer({ ...server, url: event.target.value }) }} />}
            <Button variant="primary" size="sm" data-testid="ext-mcp-add" disabled={server.name.trim() === '' || (server.kind === 'stdio' ? server.command.trim() === '' : server.url.trim() === '')} onClick={addServer}>{t('ext.add')}</Button>
          </div>
          <h3>{t('ext.skills')}</h3>
          <ul className={css.rows} data-testid="ext-skill-list">
            {skills.map(item => (
              <li key={`${item.scope}:${item.name}`} data-testid="ext-skill-item" data-name={item.name}>
                <strong>{item.name}</strong> <span className={css.notice}>{item.scope}{item.description === '' ? '' : ` · ${item.description}`}</span>
                <ConfirmButton testId="ext-skill-remove" label={t('ext.remove')} confirmLabel={t('ext.confirmRemove', { name: item.name })} cancelLabel={t('manage.cancel')}
                  onConfirm={() => { run(call(SKILLS_PATH, { body: { cwd, action: 'remove', name: item.name, scope: item.scope } satisfies SkillBodyWire }), t('ext.saved'), loadSkills) }} />
              </li>
            ))}
          </ul>
          <div className={css.form}>
            <input data-testid="ext-skill-name" placeholder={t('ext.name')} value={skill.name} onChange={(event) => { setSkill({ ...skill, name: event.target.value }) }} />
            <select data-testid="ext-skill-scope" value={skill.scope} onChange={(event) => { setSkill({ ...skill, scope: event.target.value as typeof skill.scope }) }}>
              <option value="user">user</option><option value="project">project</option>
            </select>
            <input data-testid="ext-skill-description" placeholder={t('ext.description')} value={skill.description} onChange={(event) => { setSkill({ ...skill, description: event.target.value }) }} />
            <textarea data-testid="ext-skill-body" rows={3} placeholder={t('ext.instructions')} value={skill.body} onChange={(event) => { setSkill({ ...skill, body: event.target.value }) }} />
            <Button variant="primary" size="sm" data-testid="ext-skill-add" disabled={skill.name.trim() === '' || skill.description.trim() === ''}
              onClick={() => { run(call(SKILLS_PATH, { body: { cwd, action: 'add', name: skill.name.trim(), scope: skill.scope, description: skill.description, body: skill.body } satisfies SkillBodyWire }), t('ext.saved'), () => { setSkill({ ...skill, name: '', description: '', body: '' }); loadSkills() }) }}>{t('ext.add')}</Button>
          </div>
        </>
      )}
      <h3>{t('ext.gitIdentity')}</h3>
      <div className={css.form}>
        <input data-testid="ext-git-name" placeholder="user.name" value={identity.name} onChange={(event) => { setIdentity({ ...identity, name: event.target.value }) }} />
        <input data-testid="ext-git-email" placeholder="user.email" value={identity.email} onChange={(event) => { setIdentity({ ...identity, email: event.target.value }) }} />
        <Button variant="primary" size="sm" data-testid="ext-git-save" onClick={() => { run(call(GIT_CONFIG_PATH, { body: identity }), t('ext.saved')) }}>{t('settings.save')}</Button>
      </div>
      {status !== undefined && <p className={status.kind === 'error' ? css.error : css.notice} role="status" data-testid="ext-status">{status.text}</p>}
    </div>
  )
}
