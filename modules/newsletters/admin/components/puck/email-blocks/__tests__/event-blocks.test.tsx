import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { LocalEventsBlock } from '../blocks/LocalEvents.js';
import { VirtualEventsBlock } from '../blocks/VirtualEvents.js';
import { parseLocalConfig, parseVirtualConfig } from '../../../../../workers/event-personalisation.js';

const L = LocalEventsBlock.Component;
const V = VirtualEventsBlock.Component;

describe('LocalEvents block', () => {
  it('publish path emits the token + a parseable config marker', async () => {
    const html = await render(
      <L heading="Near You" intro="hey" max_events={2} radius_miles={50} editMode={false} />,
    );
    expect(html).toContain('{{local_events_block}}');
    expect(html).toContain('gw-local-events');
    // The worker must be able to recover the authored config from the marker.
    const cfg = parseLocalConfig(html);
    expect(cfg.heading).toBe('Near You');
    expect(cfg.max).toBe(2);
    expect(cfg.radiusKm).toBeCloseTo(50 * 1.60934, 2);
  });

  it('editor path shows a static preview, not the token', async () => {
    const html = await render(
      <L heading="Near You" intro="" max_events={3} radius_miles={100} editMode={true} />,
    );
    expect(html).not.toContain('{{local_events_block}}');
    expect(html).toContain('Near You');
    expect(html).toContain('Bay Area MLOps Meetup'); // sample content
  });
});

describe('VirtualEvents block', () => {
  it('publish path emits the token + a parseable config marker', async () => {
    const html = await render(
      <V heading="Online Soon" intro="" max_events={4} editMode={false} />,
    );
    expect(html).toContain('{{virtual_events_block}}');
    const cfg = parseVirtualConfig(html);
    expect(cfg.heading).toBe('Online Soon');
    expect(cfg.max).toBe(4);
  });

  it('editor path shows a static preview', async () => {
    const html = await render(<V heading="Online Soon" intro="" max_events={5} editMode={true} />);
    expect(html).not.toContain('{{virtual_events_block}}');
    expect(html).toContain('Online Soon');
  });
});
