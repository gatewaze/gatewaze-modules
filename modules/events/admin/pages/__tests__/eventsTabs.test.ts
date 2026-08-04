import { describe, expect, it } from 'vitest';
import {
  EVENTS_BASE_TAB,
  buildEventsTabs,
  eventsTabPath,
  extractTabDescriptors,
  resolveActiveTabId,
  type RawTabSlot,
} from '../eventsTabs';

const noopComponent = () => Promise.resolve({ default: () => null });

function slot(meta: unknown, order?: number): RawTabSlot {
  return { registration: { meta, order, component: noopComponent } };
}

describe('extractTabDescriptors', () => {
  it('keeps only slots with both a tabId and a label', () => {
    const slots: RawTabSlot[] = [
      slot({ tabId: 'hosts', label: 'Hosts' }, 10),
      slot({ tabId: 'missing-label' }, 20),
      slot({ label: 'No Id' }, 30),
      slot(undefined, 40),
      slot({}, 50),
    ];
    const result = extractTabDescriptors(slots);
    expect(result.map((t) => t.id)).toEqual(['hosts']);
  });

  it('sorts by declared order and defaults a missing order to 100', () => {
    const slots: RawTabSlot[] = [
      slot({ tabId: 'speakers', label: 'Speakers' }, 20),
      slot({ tabId: 'late', label: 'Late' }), // no order -> 100
      slot({ tabId: 'hosts', label: 'Hosts' }, 10),
    ];
    const result = extractTabDescriptors(slots);
    expect(result.map((t) => t.id)).toEqual(['hosts', 'speakers', 'late']);
    expect(result.find((t) => t.id === 'late')?.order).toBe(100);
  });

  it('passes the slot component through unchanged', () => {
    const [descriptor] = extractTabDescriptors([slot({ tabId: 'hosts', label: 'Hosts' })]);
    expect(descriptor.component).toBe(noopComponent);
  });

  it('returns an empty array when there are no slots', () => {
    expect(extractTabDescriptors([])).toEqual([]);
  });
});

describe('buildEventsTabs', () => {
  it('always puts the Events base tab first', () => {
    const descriptors = extractTabDescriptors([
      slot({ tabId: 'hosts', label: 'Hosts' }, 10),
      slot({ tabId: 'speakers', label: 'Speakers' }, 20),
    ]);
    expect(buildEventsTabs(descriptors)).toEqual([
      { id: 'events', label: 'Events' },
      { id: 'hosts', label: 'Hosts' },
      { id: 'speakers', label: 'Speakers' },
    ]);
  });

  it('returns just the base tab when nothing is contributed', () => {
    expect(buildEventsTabs([])).toEqual([{ id: EVENTS_BASE_TAB.id, label: EVENTS_BASE_TAB.label }]);
  });
});

describe('resolveActiveTabId', () => {
  const tabIds = ['events', 'hosts', 'speakers'];

  it('returns events for the base route', () => {
    expect(resolveActiveTabId('/events', tabIds)).toBe('events');
  });

  it('returns the matching tab for a known single segment', () => {
    expect(resolveActiveTabId('/events/hosts', tabIds)).toBe('hosts');
    expect(resolveActiveTabId('/events/speakers', tabIds)).toBe('speakers');
  });

  it('falls back to events for an unknown tab segment', () => {
    expect(resolveActiveTabId('/events/unknown', tabIds)).toBe('events');
  });

  it('falls back to events for deeper detail routes', () => {
    // /events/:eventId/:tab must not light up a top-level tab.
    expect(resolveActiveTabId('/events/evt_123/registrations', tabIds)).toBe('events');
    expect(resolveActiveTabId('/events/evt_123', tabIds)).toBe('events');
  });
});

describe('eventsTabPath', () => {
  it('maps the base tab to /events', () => {
    expect(eventsTabPath('events')).toBe('/events');
  });

  it('maps a contributed tab to /events/<id>', () => {
    expect(eventsTabPath('hosts')).toBe('/events/hosts');
    expect(eventsTabPath('speakers')).toBe('/events/speakers');
  });
});
