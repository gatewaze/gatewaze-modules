import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerHostMediaConsumer,
  getHostMediaConsumer,
  isKnownHostKind,
  listHostMediaConsumers,
  _resetRegistryForTests,
} from '../registry.js';

describe('host_kind registry', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('starts empty', () => {
    expect(isKnownHostKind('site')).toBe(false);
    expect(getHostMediaConsumer('site')).toBeUndefined();
    expect(listHostMediaConsumers()).toEqual([]);
  });

  it('registers a consumer and reads it back', () => {
    registerHostMediaConsumer({
      hostKind: 'site',
      enableAlbums: false,
      enableYouTube: false,
    });
    expect(isKnownHostKind('site')).toBe(true);
    expect(getHostMediaConsumer('site')).toMatchObject({ hostKind: 'site', enableAlbums: false });
  });

  it('lists all registered consumers', () => {
    registerHostMediaConsumer({ hostKind: 'site' });
    registerHostMediaConsumer({ hostKind: 'event', enableYouTube: true, enableAlbums: true });
    const consumers = listHostMediaConsumers();
    expect(consumers).toHaveLength(2);
    expect(consumers.map((c) => c.hostKind).sort()).toEqual(['event', 'site']);
  });

  it('replaces a registration when the same hostKind is registered twice', () => {
    registerHostMediaConsumer({ hostKind: 'site', enableYouTube: false });
    registerHostMediaConsumer({ hostKind: 'site', enableYouTube: true });
    expect(getHostMediaConsumer('site')?.enableYouTube).toBe(true);
    expect(listHostMediaConsumers()).toHaveLength(1);
  });

  it('reports unknown kinds as unknown', () => {
    registerHostMediaConsumer({ hostKind: 'site' });
    expect(isKnownHostKind('rogue-kind')).toBe(false);
  });
});
