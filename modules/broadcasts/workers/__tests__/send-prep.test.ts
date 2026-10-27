import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_AUDIENCE_REASON,
  REFRESH_RETRY_WINDOW_MS,
  SEGMENT_FRESHNESS_MS,
  prepareSend,
  type AudienceDb,
  type DueSend,
} from '../send-prep'

const NOW = Date.parse('2026-10-29T15:30:00Z')
const SCHEDULED = '2026-10-29T15:30:00Z'

function db(over: Partial<AudienceDb> = {}): AudienceDb {
  return {
    segmentCalculatedAt: vi.fn(async () => new Date(NOW - 2 * SEGMENT_FRESHNESS_MS).toISOString()),
    recalculate: vi.fn(async () => undefined),
    fanout: vi.fn(async () => undefined),
    countRecipients: vi.fn(async () => 120),
    ...over,
  }
}

const segmentSend = (over: Partial<DueSend> = {}): DueSend => ({
  id: 'send-1',
  metadata: { portal_base_url: 'https://aaif.live' },
  audience_type: 'segment',
  segment_id: 'seg-1',
  scheduled_at: SCHEDULED,
  ...over,
})

describe('prepareSend', () => {
  it('refreshes a stale segment, fans out and starts, keeping existing metadata', async () => {
    const d = db()
    const prep = await prepareSend(segmentSend(), d, NOW)
    expect(d.recalculate).toHaveBeenCalledWith('seg-1')
    expect(d.fanout).toHaveBeenCalledWith('send-1')
    expect(prep.action).toBe('start')
    expect(prep.metadata.portal_base_url).toBe('https://aaif.live')
    expect(prep.metadata.audience_refresh).toMatchObject({ status: 'refreshed' })
  })

  it('skips the refresh when the segment was calculated within the hour', async () => {
    const recent = new Date(NOW - SEGMENT_FRESHNESS_MS + 60_000).toISOString()
    const d = db({ segmentCalculatedAt: vi.fn(async () => recent) })
    const prep = await prepareSend(segmentSend(), d, NOW)
    expect(d.recalculate).not.toHaveBeenCalled()
    expect(prep.metadata.audience_refresh).toMatchObject({ status: 'skipped', calculated_at: recent })
  })

  it('refreshes a segment that was never calculated', async () => {
    const d = db({ segmentCalculatedAt: vi.fn(async () => null) })
    await prepareSend(segmentSend(), d, NOW)
    expect(d.recalculate).toHaveBeenCalled()
  })

  it('does not touch segments for a list audience', async () => {
    const d = db()
    const prep = await prepareSend(segmentSend({ audience_type: 'list', segment_id: null }), d, NOW)
    expect(d.segmentCalculatedAt).not.toHaveBeenCalled()
    expect(d.recalculate).not.toHaveBeenCalled()
    expect(prep.action).toBe('start')
    expect(prep.metadata.audience_refresh).toBeUndefined()
  })

  it('waits for the next tick when the refresh fails inside the retry window, without fanning out', async () => {
    const d = db({ recalculate: vi.fn(async () => { throw new Error('canceling statement due to statement timeout') }) })
    const prep = await prepareSend(segmentSend(), d, NOW + REFRESH_RETRY_WINDOW_MS - 1)
    expect(prep.action).toBe('retry')
    expect(d.fanout).not.toHaveBeenCalled()
    expect(prep.metadata.audience_refresh).toMatchObject({ status: 'retrying', attempts: 1, error: 'canceling statement due to statement timeout' })
  })

  it('counts attempts across ticks', async () => {
    const d = db({ recalculate: vi.fn(async () => { throw new Error('forbidden') }) })
    const prep = await prepareSend(segmentSend({ metadata: { audience_refresh: { status: 'retrying', attempts: 2 } } }), d, NOW)
    expect(prep.metadata.audience_refresh).toMatchObject({ attempts: 3 })
  })

  it('sends to the stored audience once the retry window has passed, and records why', async () => {
    const stored = new Date(NOW - 20 * 60 * 60 * 1000).toISOString()
    const d = db({
      segmentCalculatedAt: vi.fn(async () => stored),
      recalculate: vi.fn(async () => { throw new Error('forbidden') }),
    })
    const prep = await prepareSend(segmentSend(), d, NOW + REFRESH_RETRY_WINDOW_MS)
    expect(prep.action).toBe('start')
    expect(d.fanout).toHaveBeenCalled()
    expect(prep.metadata.audience_refresh).toMatchObject({ status: 'failed', error: 'forbidden', used_audience_calculated_at: stored })
  })

  it('fails with the fan-out error as the reason', async () => {
    const d = db({ fanout: vi.fn(async () => { throw new Error('canceling statement due to statement timeout') }) })
    const prep = await prepareSend(segmentSend(), d, NOW)
    expect(prep.action).toBe('fail')
    expect(prep.metadata.error).toBe('Fan-out failed: canceling statement due to statement timeout')
    expect(d.countRecipients).not.toHaveBeenCalled()
  })

  it('stores only the start of a long error', async () => {
    const d = db({ fanout: vi.fn(async () => { throw new Error('x'.repeat(5000)) }) })
    const prep = await prepareSend(segmentSend(), d, NOW)
    expect(String(prep.metadata.error).length).toBeLessThan(400)
  })

  it('fails an empty audience with the suppression reason', async () => {
    const d = db({ countRecipients: vi.fn(async () => 0) })
    const prep = await prepareSend(segmentSend(), d, NOW)
    expect(prep.action).toBe('fail')
    expect(prep.metadata.error).toBe(EMPTY_AUDIENCE_REASON)
  })

  it('still refreshes when reading the last calculation time fails', async () => {
    const d = db({ segmentCalculatedAt: vi.fn(async () => { throw new Error('network') }) })
    await prepareSend(segmentSend(), d, NOW)
    expect(d.recalculate).toHaveBeenCalled()
  })
})
