/** What the engine offers for a working directory (models, commands, MCP servers, account), cached per page. */
import { useCallback, useEffect, useState } from 'react'
import { INFO_PATH, type InfoWire } from '../protocol.ts'

const cache = new Map<string, InfoWire>()
/** Latest info per engine, shown for a folder whose own info is still loading; models and defaults rarely differ between folders. */
const latest = new Map<string, InfoWire>()
const inflight = new Map<string, Promise<InfoWire>>()

/** Fetch (or reuse) the info of one engine and directory. */
export async function loadInfo(engine: 'claude' | 'codex', cwd: string, fresh = false): Promise<InfoWire> {
  const key = `${engine}:${cwd}`
  const known = cache.get(key)
  if (known !== undefined && !fresh) return known
  const pending = inflight.get(key)
  if (pending !== undefined && !fresh) return await pending
  const request = fetch(`${INFO_PATH}?${new URLSearchParams({ engine, cwd, ...fresh ? { fresh: '1' } : {} }).toString()}`, { credentials: 'same-origin' })
    .then(async (response) => {
      const body = await response.json() as InfoWire & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      cache.set(key, body)
      latest.set(engine, body)
      return body
    })
    .finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  return await request
}

/** Hook over {@link loadInfo}. */
export function useInfo(engine: 'claude' | 'codex', cwd: string | undefined): {
  info: InfoWire | undefined; error: string | undefined; reload: () => void
} {
  // Kept with the engine and folder it was loaded for, so another session never shows this one's models.
  const [info, setInfo] = useState<{ key: string; value: InfoWire } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [version, setVersion] = useState(0)
  const key = `${engine}:${cwd ?? ''}`
  useEffect(() => {
    if (cwd === undefined || cwd === '') return undefined
    let cancelled = false
    void loadInfo(engine, cwd, version > 0).then(
      (value) => { if (!cancelled) { setInfo({ key: `${engine}:${cwd}`, value }); setError(undefined) } },
      (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) },
    )
    return () => { cancelled = true }
  }, [engine, cwd, version])
  return { info: info?.key === key ? info.value : latest.get(engine), error, reload: useCallback(() => { setVersion(n => n + 1) }, []) }
}
