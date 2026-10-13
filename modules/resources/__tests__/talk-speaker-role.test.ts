import { describe, it, expect } from 'vitest';
import { validateBlock, BLOCK_KINDS } from '../blocks';
import { renderTalkCardHtml } from '../portal/render-blocks';

/**
 * The talk card's `speaker.role` field.
 *
 * A conference programme prints a name, a job title and a company as three
 * separate values. The card only had `name` and `company`, so a pipeline with
 * all three had to either drop the job title or paste it into `company`. The
 * live AAIF recap did the latter by accident, and a card read "Founding ML
 * Engineer, Runlayer" as the company name.
 *
 * `role` is additive on an open schema, so the tests that matter are: it is
 * length-bounded like every other rendered field, it is escaped, and a card
 * without it renders exactly as it did before.
 */

const block = (speaker: Record<string, unknown>) => ({
  id: 'b1',
  kind: 'talk',
  slug: 'a-talk',
  sort_order: 0,
  data: { title: 'A Talk', speaker },
});

const render = (speaker: Record<string, unknown>): string =>
  renderTalkCardHtml(block(speaker) as never, 0, { pagePath: '/resources/x' } as never);

const issues = (speaker: Record<string, unknown>) =>
  validateBlock(block(speaker) as never, 'test');

describe('speaker.role validation', () => {
  it('accepts a job title', () => {
    expect(issues({ name: 'Liran Tal', role: 'Director of Developer Relations', company: 'Snyk' }))
      .toHaveLength(0);
  });

  it('bounds the length, so it cannot be used to blow up a card', () => {
    const bad = issues({ name: 'Liran Tal', role: 'R'.repeat(121) });
    expect(bad.some((i) => i.keyword === 'maxLength')).toBe(true);
  });

  it('is declared on the video block too, which reuses the talk properties', () => {
    const props = BLOCK_KINDS.video.jsonSchema.properties as Record<string, never>;
    const speaker = props.speaker as unknown as { properties: Record<string, unknown> };
    expect(speaker.properties.role).toBeDefined();
  });
});

describe('the talk renderer sub-line', () => {
  it('reads "role, company" when the programme gave both', () => {
    const html = render({ name: 'Liran Tal', role: 'Director of Developer Relations', company: 'Snyk' });
    expect(html).toContain('Director of Developer Relations, Snyk');
  });

  it('shows the company alone when there is no role, as it always did', () => {
    const html = render({ name: 'Liran Tal', company: 'Snyk' });
    expect(html).toContain('Snyk');
    expect(html).not.toContain(', Snyk');
  });

  it('shows the role alone when there is no company', () => {
    const html = render({ name: 'Liran Tal', role: 'Independent Consultant' });
    expect(html).toContain('Independent Consultant');
    expect(html).not.toContain('Independent Consultant,');
  });

  it('emits no sub-line at all when the speaker has neither', () => {
    const html = render({ name: 'Liran Tal' });
    expect(html).toContain('Liran Tal');
    expect(html).not.toContain('margin-top:2px;"></div>');
  });

  it('escapes a role, because this renderer emits raw HTML', () => {
    const html = render({ name: 'Liran Tal', role: '<script>alert(1)</script>', company: 'Snyk' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('ignores a non-string role rather than printing it', () => {
    const html = render({ name: 'Liran Tal', role: { evil: true }, company: 'Snyk' });
    expect(html).toContain('Snyk');
    expect(html).not.toContain('[object Object]');
  });
});

describe('the photo strip sits the same distance below its heading as body copy', () => {
  // Body copy gets 2px of margin plus the half-leading of a 14px/1.5
  // line. A row of images has no leading, so without an explicit margin
  // the strip sat flush under "Photos from this session" while the two
  // text blocks above it breathed (reported 2026-10-13).
  const withPhotos = (): string => renderTalkCardHtml(
    {
      id: 'b1',
      kind: 'talk',
      slug: 'a-talk',
      sort_order: 0,
      data: {
        title: 'A Talk',
        speaker: { name: 'A Speaker' },
        photos: [{ src: 'https://cdn.test/a.jpg', thumb: 'https://cdn.test/a-t.jpg', alt: 'a' }],
      },
    } as never,
    0,
    { pagePath: '/resources/x' } as never,
  );

  it('gives the strip an explicit top margin', () => {
    const strip = /<div id="gw-ts-b1" style="([^"]*)"/.exec(withPhotos());
    expect(strip, 'photo strip not rendered').toBeTruthy();
    expect(strip![1]).toContain('margin-top:6px');
  });

  it('leaves the label flush, so the gap is set in one place', () => {
    const label = /<p style="([^"]*)">Photos from this session<\/p>/.exec(withPhotos());
    expect(label, 'photo label not rendered').toBeTruthy();
    expect(label![1]).toContain('margin:0;');
  });

  it('renders no strip at all when the talk has no photos', () => {
    expect(render({ name: 'A Speaker' })).not.toContain('Photos from this session');
  });
});
