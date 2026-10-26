import { describe, expect, it, vi } from 'vitest';
import { fallbackEntityLabel, formatEventLabel, resolveEntityLabel, type EventLookup } from '../entityLabel';

const EVENT_UUID = '7e2a2289-3a6d-49d8-ae04-bd591046f875';

describe('resolveEntityLabel', () => {
  it('names a stored event by UUID, in the vocabulary format', async () => {
    const lookup = vi.fn<EventLookup>(async () => ({ event_title: 'MLOps Days Sunnyvale', event_start: '2025-06-05T16:00:00+00:00' }));
    await expect(resolveEntityLabel('event_registration', EVENT_UUID, lookup)).resolves.toBe('MLOps Days Sunnyvale — 2025-06-05');
    expect(lookup).toHaveBeenCalledWith('id', EVENT_UUID);
  });

  it('looks a short code up by event_id', async () => {
    const lookup = vi.fn<EventLookup>(async () => ({ event_title: 'Voice Agents Forum', event_start: null }));
    await expect(resolveEntityLabel('event_registration', '7afa6e', lookup)).resolves.toBe('Voice Agents Forum');
    expect(lookup).toHaveBeenCalledWith('event_id', '7afa6e');
  });

  it('returns null for a deleted event or another kind', async () => {
    const none = vi.fn<EventLookup>(async () => null);
    await expect(resolveEntityLabel('event_registration', EVENT_UUID, none)).resolves.toBeNull();
    await expect(resolveEntityLabel('calendar_member', EVENT_UUID, none)).resolves.toBeNull();
    expect(none).toHaveBeenCalledTimes(1);
  });
});

describe('labels', () => {
  it('drops an empty title', () => {
    expect(formatEventLabel({ event_title: '  ', event_start: '2025-06-05' })).toBeNull();
  });

  it('shortens a UUID in the fallback label', () => {
    expect(fallbackEntityLabel('Event registration', EVENT_UUID)).toBe('Event registration: 7e2a2289… (not in the list above)');
  });
});
