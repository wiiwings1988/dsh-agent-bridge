/** Search across the conversations of every engine. */
import { useEffect, useState } from 'react'
import { SEARCH_PATH, type SearchHitWire } from '../protocol.ts'
import type { Translate } from './ToolCard.tsx'
import css from './ExternalPanel.module.css'

/** Search input with a result list; picking a result opens that session. */
export function SearchBox({ onOpen, t }: { onOpen: (id: string) => void; t: Translate }) {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<SearchHitWire[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (term.trim().length < 2) { setHits(undefined); return undefined }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void fetch(`${SEARCH_PATH}?${new URLSearchParams({ q: term.trim() }).toString()}`, { credentials: 'same-origin' })
        .then(async (response) => {
          const body = await response.json() as { hits: SearchHitWire[]; error?: string }
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
          if (!cancelled) { setHits(body.hits); setError(undefined) }
        })
        .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    }, 350)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [term])
  return (
    <div className={css.search}>
      <input data-testid="ext-search" type="search" value={term} placeholder={t('search.placeholder')} onChange={(event) => { setTerm(event.target.value) }} />
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      {hits !== undefined && (
        <ul className={css.searchHits} data-testid="ext-search-hits">
          {hits.length === 0 && <li className={css.meta}>{t('search.none')}</li>}
          {hits.map(hit => (
            <li key={hit.id}>
              <button type="button" data-testid="ext-search-hit" data-id={hit.id} onClick={() => { onOpen(hit.id); setTerm('') }}>
                <strong>{hit.title}</strong>{hit.snippet !== '' && <small>{hit.snippet}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
