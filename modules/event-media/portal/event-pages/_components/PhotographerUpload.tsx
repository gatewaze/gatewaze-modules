'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * The photographer's own page.
 *
 * A wedding's professional photographs arrive weeks later, in the
 * thousands, from one person or one company (asked 2026-09-28). That is
 * a delivery, not a party: there is no booth, no gallery, nobody to be,
 * and nothing to see afterwards -- the photographs go straight into the
 * organiser's Photographer album, which is not on the portal until they
 * say so.
 *
 * Built for a laptop and eight thousand files rather than a phone and a
 * handful: a folder at a time, a few in flight, one bad file passed over
 * rather than stopping the rest, and a record of what has been sent so a
 * closed laptop can be opened again without sending it all twice.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  type DeliveryFile,
  type DeliveryProgress,
  fileKey,
  inBatches,
  isDeliverable,
  progressLine,
  toDeliver,
} from './_lib/delivery'

const API_BASE = ''
/** Files per mint call; the server takes twenty. */
const MINT_BATCH = 20
/** How many uploads are in the air at once. */
const IN_FLIGHT = 4

interface Props {
  code: string
  credit: string | null
  allowVideo: boolean
  eventName: string | null
  darkMode?: boolean
}

interface Minted {
  media_id: string
  upload_url: string
  ticket: string
  filename: string
  status?: string
  message?: string
}

export default function PhotographerUpload({ code, credit, allowVideo, eventName, darkMode }: Props) {
  const [progress, setProgress] = useState<DeliveryProgress>({ total: 0, done: 0, failed: 0, skipped: 0 })
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const stop = useRef(false)
  const folder = useRef<HTMLInputElement | null>(null)
  const loose = useRef<HTMLInputElement | null>(null)

  const text = darkMode ? 'text-white' : 'text-gray-900'
  const subText = darkMode ? 'text-white/70' : 'text-gray-600'

  /**
   * What this browser has already sent for this link. Kept per link, so
   * a photographer working on two events does not confuse them.
   */
  const doneKey = `event_media_delivered:${code}`
  const readDone = useCallback((): Set<string> => {
    try {
      const raw = localStorage.getItem(doneKey)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  }, [doneKey])
  const remember = useCallback((keys: string[]) => {
    try {
      const all = readDone()
      for (const k of keys) all.add(k)
      localStorage.setItem(doneKey, JSON.stringify([...all]))
    } catch {
      // A browser that will not remember still delivers; it just cannot
      // pick up where it left off.
    }
  }, [doneKey, readDone])

  const send = useCallback(async (chosen: File[]) => {
    setProblem(null)
    setFinished(false)
    stop.current = false

    const already = readDone()
    const usable = chosen.filter((f) => isDeliverable(f as DeliveryFile, { allowVideo }))
    const queue = toDeliver(usable as unknown as DeliveryFile[], already) as unknown as File[]
    const skipped = usable.length - queue.length
    const state: DeliveryProgress = { total: queue.length, done: 0, failed: 0, skipped }
    setProgress({ ...state })
    if (queue.length === 0) { setFinished(true); return }

    setRunning(true)
    try {
      for (const batch of inBatches(queue, MINT_BATCH)) {
        if (stop.current) break
        const mint = await fetch(`${API_BASE}/api/public/event-media/links/${code}/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId(code),
            files: batch.map((f) => ({
              filename: f.name, mime_type: f.type || 'image/jpeg', bytes: f.size, captured: false,
            })),
          }),
        })
        const minted = await mint.json().catch(() => null)
        if (!mint.ok || !minted?.items) {
          setProblem(minted?.message ?? 'The upload stopped. Nothing already sent is lost; start it again to carry on.')
          break
        }

        // A few at a time: a photographer's connection is the bottleneck
        // and forty at once makes it slower, not faster.
        const tickets: string[] = []
        const sent: string[] = []
        for (const group of inBatches(minted.items as Minted[], IN_FLIGHT)) {
          if (stop.current) break
          await Promise.all(group.map(async (item, i) => {
            const file = batch[(minted.items as Minted[]).indexOf(item)] ?? batch[i]
            if (!file || item.status === 'failed' || !item.upload_url) { state.failed += 1; return }
            try {
              const put = await fetch(item.upload_url, {
                method: 'PUT',
                headers: { 'Content-Type': file.type || 'image/jpeg' },
                body: file,
              })
              if (!put.ok) throw new Error(`upload ${put.status}`)
              tickets.push(item.ticket)
              sent.push(fileKey(file as unknown as DeliveryFile))
              state.done += 1
            } catch {
              // One file that will not go must not stop the delivery.
              state.failed += 1
            }
            setProgress({ ...state })
          }))
        }

        if (tickets.length > 0) {
          await fetch(`${API_BASE}/api/public/event-media/links/${code}/uploads/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickets }),
          }).catch(() => null)
          remember(sent)
        }
        setProgress({ ...state })
      }
      setFinished(true)
    } finally {
      setRunning(false)
    }
  }, [allowVideo, code, readDone, remember])

  const pick = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return
    void send(Array.from(list))
  }, [send])

  const line = useMemo(() => progressLine(progress), [progress])

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className={`text-xl font-semibold ${text}`}>
        {eventName ? `${eventName}: photographs` : 'Deliver the photographs'}
      </h1>
      <p className={`mt-2 text-sm ${subText}`}>
        {credit
          ? `Everything sent from this page is filed as ${credit}'s.`
          : 'Everything sent from this page is filed as the photographer’s.'}
        {' '}It goes straight to the couple, in one album, at the size you send it.
        Nobody else can see it until they say so.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          onClick={() => folder.current?.click()}
          disabled={running}
          className="rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-50"
          style={{ background: '#ffffff', color: '#111827' }}
        >
          Choose a folder
        </button>
        <button
          onClick={() => loose.current?.click()}
          disabled={running}
          className={`rounded-lg px-4 py-2.5 text-sm ${subText} disabled:opacity-50`}
          style={{ background: darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)' }}
        >
          Choose files
        </button>
        {running && (
          <button
            onClick={() => { stop.current = true }}
            className={`rounded-lg px-4 py-2.5 text-sm ${subText}`}
            style={{ background: darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)' }}
          >
            Stop
          </button>
        )}
      </div>

      {/* webkitdirectory is how a browser offers a whole folder. */}
      <input
        ref={folder}
        type="file"
        multiple
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ webkitdirectory: '', directory: '' } as any)}
        className="hidden"
        onChange={(e) => pick(e.target.files)}
      />
      <input ref={loose} type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => pick(e.target.files)} />

      {line && <p className={`mt-6 text-sm ${text}`}>{line}</p>}
      {running && progress.total > 0 && (
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full" style={{ background: 'rgba(127,127,127,0.25)' }}>
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{ width: `${Math.round(((progress.done + progress.failed) / progress.total) * 100)}%`, background: '#ffffff' }}
          />
        </div>
      )}
      {problem && <p className="mt-3 text-sm text-amber-400">{problem}</p>}
      {finished && !running && progress.total > 0 && (
        <p className={`mt-3 text-sm ${subText}`}>
          Done. You can close this page; choosing the same folder again will only send what is missing.
        </p>
      )}

      <p className={`mt-10 text-xs ${subText}`}>
        Large deliveries take a while — leave this page open while it works. If it is interrupted,
        open it again and choose the same folder: everything already here is passed over.
      </p>
    </div>
  )
}

/** One id per link per browser, so the server can tell deliveries apart. */
function clientId(code: string): string {
  const key = `event_media_delivery_client:${code}`
  try {
    const held = localStorage.getItem(key)
    if (held) return held
    const made = crypto.randomUUID()
    localStorage.setItem(key, made)
    return made
  } catch {
    return crypto.randomUUID()
  }
}
