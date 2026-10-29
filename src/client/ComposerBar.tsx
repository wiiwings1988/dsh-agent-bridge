/** Controls of the composer card: model, effort, attachments, and the slash-command menu. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconPlus } from './icons.tsx'
import { CHOICE_PATH, type AttachmentWire, type ChoiceWire, type CommandWire, type InfoWire } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import { DictateButton, useVoiceEnabled } from './voice.tsx'
import css from './ExternalPanel.module.css'

/** Model and effort picked for an engine; the server keeps the last pick, so every browser starts from it. */
export type Choice = ChoiceWire

const NO_CHOICE: Choice = { model: '', effort: '' }

function saveChoice(engine: string, choice: Choice): void {
  void fetch(CHOICE_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine, ...choice }) }).catch(() => {})
}

/**
 * The engine's saved choice and a setter that saves the new one.
 * @param engine - engine whose choice is shown.
 * @returns the choice (no choice until the saved one arrives) and its setter.
 */
export function useChoice(engine: string): [Choice, (choice: Choice) => void] {
  const [loaded, setLoaded] = useState<{ engine: string; choice: Choice } | undefined>(undefined)
  // A pick made while the saved choice is still loading wins over the saved one.
  const picked = useRef<string | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    picked.current = undefined
    void fetch(`${CHOICE_PATH}?${new URLSearchParams({ engine }).toString()}`, { credentials: 'same-origin' })
      .then(async response => await response.json() as Choice)
      .then((choice) => { if (!cancelled && picked.current !== engine) setLoaded({ engine, choice }) }, () => {})
    return () => { cancelled = true }
  }, [engine])
  const set = useCallback((choice: Choice): void => { picked.current = engine; setLoaded({ engine, choice }); saveChoice(engine, choice) }, [engine])
  return [loaded?.engine === engine ? loaded.choice : NO_CHOICE, set]
}

/** Read files into attachments. */
export async function toAttachments(files: readonly File[]): Promise<AttachmentWire[]> {
  return await Promise.all(files.map(async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { name: file.name, mime: file.type || 'application/octet-stream', base64: btoa(binary) }
  }))
}

/** Commands whose name starts with what the user typed after the slash. */
export function matchCommands(text: string, commands: readonly CommandWire[]): CommandWire[] {
  const found = /^\/(\S*)$/.exec(text)
  if (found === null) return []
  const typed = (found[1] ?? '').toLowerCase()
  return commands.filter(command => command.name.toLowerCase().startsWith(typed)).slice(0, 8)
}

/** Slash-command menu above the message box. */
export function SlashMenu({ text, commands, onPick }: { text: string; commands: readonly CommandWire[]; onPick: (name: string) => void }) {
  const matches = matchCommands(text, commands)
  if (matches.length === 0) return null
  return (
    <ul className={css.slashMenu} data-testid="ext-slash-menu" role="listbox">
      {matches.map(command => (
        <li key={command.name}>
          <button type="button" role="option" data-testid="ext-slash-item" data-name={command.name} onClick={() => { onPick(command.name) }}>
            <code>/{command.name}</code> {command.argumentHint !== '' && <span>{command.argumentHint}</span>} <small>{command.description}</small>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Attachments waiting to be sent, shown inside the composer card above the text. */
export function AttachmentChips({ attachments, onRemove, t }: { attachments: readonly AttachmentWire[]; onRemove: (index: number) => void; t: Translate }) {
  if (attachments.length === 0) return null
  return (
    <ul className={css.chips} data-testid="ext-attachments">
      {attachments.map((item, index) => (
        <li key={`${item.name}-${index}`} data-testid="ext-attachment">
          {item.mime.startsWith('image/') && <img alt="" src={`data:${item.mime};base64,${item.base64}`} />}
          <span>{item.name}</span>
          <button type="button" aria-label={t('composer.removeAttachment')} onClick={() => { onRemove(index) }}>×</button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Toolbar controls of the composer card. As in the dsh composer, the leading part (attach, dictate)
 * opens the toolbar and the trailing part (model, effort) sits beside the send button.
 */
export function ComposerBar({ part, info, choice, onChoice, onAttach, onDictated, t }: {
  part: 'leading' | 'trailing'
  info: InfoWire | undefined
  choice: Choice
  onChoice: (choice: Choice) => void
  onAttach: (files: File[]) => void
  onDictated: (text: string) => void
  t: Translate
}) {
  const voice = useVoiceEnabled()
  const models = info?.models ?? []
  const current = models.find(model => model.value === choice.model)
  // Claude marks no entry as default; its list names the default model with the value `default`.
  const fallback = models.find(model => model.isDefault === true) ?? models.find(model => model.value === 'default')
  const efforts = current?.efforts ?? fallback?.efforts ?? []
  const [picker, setPicker] = useState<HTMLInputElement | null>(null)
  const [customMode, setCustomMode] = useState(false)
  const custom = customMode || (choice.model !== '' && models.length > 0 && current === undefined)
  const defaultModel = info?.defaults?.model
  // The engine's default effort belongs to its default model; with another model picked it falls back to that model's own default.
  const defaultEffort = choice.model === '' ? info?.defaults?.effort : undefined
  useEffect(() => {
    if (choice.effort !== '' && efforts.length > 0 && !efforts.includes(choice.effort)) {
      onChoice({ ...choice, effort: '' })
    }
  }, [choice, efforts, onChoice])
  const update = (patch: Partial<Choice>): void => { onChoice({ ...choice, ...patch }) }
  if (part === 'leading') {
    return (
      <>
        <button type="button" className={css.add} data-testid="ext-attach" aria-label={t('composer.attach')} title={t('composer.attach')} onClick={() => { picker?.click() }}>
          <IconPlus size={14} />
        </button>
        <input
          ref={setPicker} type="file" multiple hidden data-testid="ext-attach-input"
          onChange={(event) => { onAttach(Array.from(event.target.files ?? [])); event.target.value = '' }}
        />
        {voice && <DictateButton onText={onDictated} t={t} className={css.iconTool} />}
      </>
    )
  }
  return (
    <>
      <select
        className={css.select} data-testid="ext-model" aria-label={t('composer.model')} title={t('composer.model')} value={custom ? '__custom__' : choice.model}
        onChange={(event) => {
          if (event.target.value === '__custom__') { setCustomMode(true); update({ model: '', effort: '' }) } else { setCustomMode(false); update({ model: event.target.value, effort: '' }) }
        }}
      >
        <option value="" data-testid="ext-model-default">{defaultModel === undefined ? t('composer.default') : t('composer.defaultNamed', { name: defaultModel })}</option>
        {models.map(model => <option key={model.value} value={model.value} title={model.description}>{model.name}</option>)}
        <option value="__custom__">{t('composer.customModel')}</option>
      </select>
      {custom && <input className={css.customModel} data-testid="ext-model-custom" placeholder={t('composer.customModelPlaceholder')} value={choice.model} onChange={(event) => { update({ model: event.target.value.trim() }) }} />}
      {efforts.length > 0 && (
        <select className={css.select} data-testid="ext-effort" aria-label={t('composer.effort')} title={t('composer.effort')} value={choice.effort} onChange={(event) => { update({ effort: event.target.value }) }}>
          <option value="" data-testid="ext-effort-default">{defaultEffort === undefined ? t('composer.default') : t('composer.defaultNamed', { name: defaultEffort })}</option>
          {efforts.map(level => <option key={level} value={level}>{level}</option>)}
        </select>
      )}
    </>
  )
}
