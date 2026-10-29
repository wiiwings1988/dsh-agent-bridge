/** Configuration page of the `dsh-agent-bridge` bundle on the Plugins page. */
import { useEffect, useState } from 'react'
import { ARCHIVE_PATH, SCREEN_STATUS_PATH, SESSIONS_PATH, type SessionRowWire } from '../protocol.ts'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { notificationsOn, setNotifications } from './notify.ts'
import css from './SettingsCard.module.css'

/** Resolved section fields this card edits. */
export interface ExternalEnginesSection {
  readonly enabled: boolean
  readonly sessionLimit: number
  readonly watchIntervalMs: number
  readonly allowedTools: readonly string[]
  readonly computerUse: boolean
  readonly browserUse: boolean
  readonly browserHeaded: boolean
  readonly voiceBaseUrl: string
  readonly voiceApiKeyEnv: string
  readonly memoryFile: string
}

/** Registrant-private share arriving through the register inject factory. */
export type SettingsCardInjected = {
  hooks: {
    /** Accepted values of the plugin's entry config. */
    scope: HostObservable<ConfigFormSnapshot<ExternalEnginesSection>>
  }
  /** Store one field of the entry config. */
  save: (field: string, value: unknown) => Promise<void>
}

/** Full card props. */
export type SettingsCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'agent-bridge'>
  & PropsHooks<SettingsCardInjected['hooks']>
  & Omit<SettingsCardInjected, 'hooks'>

/**
 * Render the one-line summary, or the full page.
 * @param props - view, locale seat, bound scope hook, and the save action.
 * @returns the summary text or the page.
 */
export function SettingsCard(props: SettingsCardProps) {
  return props.view === 'summary' ? props.t('settings.description') : <SettingsPage {...props} />
}

function SettingsPage({ t, useScope, save }: SettingsCardProps) {
  const snapshot = useScope(state => state)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [toolsDraft, setToolsDraft] = useState<string | undefined>(undefined)
  const [memoryDraft, setMemoryDraft] = useState<string | undefined>(undefined)
  const memoryShown = memoryDraft ?? snapshot.value?.memoryFile ?? ''
  const toolsShown = toolsDraft ?? (snapshot.value?.allowedTools ?? []).join(', ')
  const shown = draft ?? String(snapshot.value?.sessionLimit ?? '')
  const parsed = Number(shown)
  const valid = shown !== '' && Number.isInteger(parsed) && parsed >= 1
  const [screen, setScreen] = useState<{ lines: readonly string[]; server: string; tools: readonly string[] } | 'unavailable' | undefined>(undefined)
  const [screenCheck, setScreenCheck] = useState(0)
  const [voiceUrl, setVoiceUrl] = useState<string | undefined>(undefined)
  const [voiceKey, setVoiceKey] = useState<string | undefined>(undefined)
  const [notifyOn, setNotifyOn] = useState(notificationsOn)
  const [archived, setArchived] = useState<SessionRowWire[]>([])
  const loadArchived = (): void => {
    void fetch(`${SESSIONS_PATH}?archived=1`, { credentials: 'same-origin' }).then(async response => await response.json() as { sessions: SessionRowWire[] }).then(body => { setArchived(body.sessions) }, () => {})
  }
  useEffect(loadArchived, [])
  useEffect(() => {
    let cancelled = false
    void fetch(SCREEN_STATUS_PATH, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as { lines: string[]; server: string; tools: string[] }
      })
      .then((body) => { if (!cancelled) setScreen(body) })
      .catch(() => { if (!cancelled) setScreen('unavailable') })
    return () => { cancelled = true }
  }, [screenCheck])
  const writable = snapshot.status === 'ready' && snapshot.writable
  return (
    <section className={css.card} data-testid="ext-settings-card">
      <label>
        {t('settings.limit')}{' '}
        <input
          data-testid="ext-limit"
          inputMode="numeric"
          value={shown}
          disabled={!writable}
          onChange={(event) => { setDraft(event.target.value); setSaved(false) }}
        />
      </label>
      {!valid && draft !== undefined && <p>{t('settings.invalid')}</p>}
      {!writable && <p>{t('settings.readonly')}</p>}
      <button
        type="button"
        data-testid="ext-save"
        disabled={!writable || !valid || draft === undefined}
        onClick={() => {
          void save('sessionLimit', parsed).then(() => { setDraft(undefined); setSaved(true) })
        }}
      >
        {t('settings.save')}
      </button>
      <label>
        {t('settings.allowed')}{' '}
        <input
          data-testid="ext-allowed" value={toolsShown} disabled={!writable}
          onChange={(event) => { setToolsDraft(event.target.value); setSaved(false) }}
        />
      </label>
      <button
        type="button" data-testid="ext-save-allowed" disabled={!writable || toolsDraft === undefined}
        onClick={() => {
          const tools = (toolsDraft ?? '').split(',').map(x => x.trim()).filter(x => x !== '')
          void save('allowedTools', tools).then(() => { setToolsDraft(undefined); setSaved(true) })
        }}
      >{t('settings.save')}</button>
      <label>
        {t('settings.memory')}{' '}
        <input data-testid="ext-memory" value={memoryShown} disabled={!writable} onChange={(event) => { setMemoryDraft(event.target.value); setSaved(false) }} />
      </label>
      <button
        type="button" data-testid="ext-save-memory" disabled={!writable || memoryDraft === undefined}
        onClick={() => { void save('memoryFile', memoryShown.trim()).then(() => { setMemoryDraft(undefined); setSaved(true) }) }}
      >{t('settings.save')}</button>
      <h4>{t('settings.screen')}</h4>
      <label>
        <input
          type="checkbox" data-testid="ext-screen-on" checked={snapshot.value?.computerUse ?? false} disabled={!writable}
          onChange={(event) => { void save('computerUse', event.target.checked) }}
        />
        {t('settings.screenOn')}
      </label>
      <div data-testid="ext-screen-status">
        {t('settings.screenStatus')}:{' '}
        {screen === undefined ? '…' : screen === 'unavailable' ? t('settings.screenUnavailable') : <>{screen.lines.map(line => <div key={line}>{line}</div>)}<div data-testid="ext-screen-server" data-server={screen.server} data-tools={screen.tools.join(',')}>{t('settings.screenServer')}: {screen.server} · {screen.tools.length}</div></>}
        <button type="button" data-testid="ext-screen-refresh" onClick={() => { setScreen(undefined); setScreenCheck(n => n + 1) }}>{t('settings.screenRefresh')}</button>
      </div>
      <h4>{t('settings.voice')}</h4>
      <label>
        {t('settings.voiceUrl')}{' '}
        <input data-testid="ext-voice-url" value={voiceUrl ?? snapshot.value?.voiceBaseUrl ?? ''} disabled={!writable} onChange={(event) => { setVoiceUrl(event.target.value); setSaved(false) }} />
      </label>
      <label>
        {t('settings.voiceKey')}{' '}
        <input data-testid="ext-voice-key" value={voiceKey ?? snapshot.value?.voiceApiKeyEnv ?? ''} disabled={!writable} onChange={(event) => { setVoiceKey(event.target.value); setSaved(false) }} />
      </label>
      <button
        type="button" data-testid="ext-save-voice" disabled={!writable || (voiceUrl === undefined && voiceKey === undefined)}
        onClick={() => {
          void Promise.all([
            ...voiceUrl === undefined ? [] : [save('voiceBaseUrl', voiceUrl.trim())],
            ...voiceKey === undefined ? [] : [save('voiceApiKeyEnv', voiceKey.trim())],
          ]).then(() => { setVoiceUrl(undefined); setVoiceKey(undefined); setSaved(true) })
        }}
      >{t('settings.save')}</button>
      <h4>{t('settings.browser')}</h4>
      <label>
        <input
          type="checkbox" data-testid="ext-browser-on" checked={snapshot.value?.browserUse ?? false} disabled={!writable}
          onChange={(event) => { void save('browserUse', event.target.checked) }}
        />
        {t('settings.browserOn')}
      </label>
      <label>
        <input
          type="checkbox" data-testid="ext-browser-headed" checked={snapshot.value?.browserHeaded ?? false} disabled={!writable}
          onChange={(event) => { void save('browserHeaded', event.target.checked) }}
        />
        {t('settings.browserHeaded')}
      </label>
      <label>
        <input
          type="checkbox" data-testid="ext-notify" checked={notifyOn}
          onChange={(event) => { void setNotifications(event.target.checked).then((granted) => { setNotifyOn(event.target.checked && granted) }) }}
        />
        {t('settings.notify')}
      </label>
      <h4>{t('settings.archived')}</h4>
      <ul data-testid="ext-archived">
        {archived.length === 0 && <li>{t('settings.noArchived')}</li>}
        {archived.map(row => (
          <li key={row.id} data-testid="ext-archived-row" data-id={row.id}>
            {row.title}{' '}
            <button
              type="button" data-testid="ext-restore"
              onClick={() => {
                void fetch(ARCHIVE_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id, archived: false }) }).then(() => { loadArchived(); window.dispatchEvent(new Event('agent-bridge:refresh')) })
              }}
            >{t('settings.restore')}</button>
          </li>
        ))}
      </ul>
      {saved && <span data-testid="ext-saved">{t('settings.saved')}</span>}
    </section>
  )
}
