// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render } from '@react-email/render';
import { declarativeBlockEntry } from '../from-template.js';

// Hot Take ported to the declarative html-ish format (SCHEMA + element tree).
const HOT_TAKE = `
<!-- SCHEMA: {
  "title": {"type":"text","label":"Title"},
  "body": {"type":"richtext","label":"Body"},
  "poll_option_1_label": {"type":"text"},
  "poll_option_1_link": {"type":"text"},
  "poll_option_2_label": {"type":"text"},
  "poll_option_2_link": {"type":"text"}
} -->
<Section class="card">
  <Text class="eyebrow">HOT TAKE</Text>
  <Heading if="title">{{title}}</Heading>
  <RichText field="body" class="body" />
  <Section if="poll_option_1_label">
    <Row>
      <Column><Button href="{{poll_option_1_link}}">{{poll_option_1_label}}</Button></Column>
      <Column if="poll_option_2_label"><Button href="{{poll_option_2_link}}">{{poll_option_2_label}}</Button></Column>
    </Row>
  </Section>
</Section>
`;

// Block with an array field (Useful Links) to exercise `each`.
const GENERIC = `
<!-- SCHEMA: {
  "heading": {"type":"text"},
  "useful_links": {"type":"array","fields":{"title":{"type":"text"},"url":{"type":"text"}}}
} -->
<Section class="card">
  <Text class="eyebrow">{{heading}}</Text>
  <Text each="useful_links"><Link href="{{url}}">{{title}}</Link></Text>
</Section>
`;

const renderEntry = async (source: string, props: Record<string, unknown>): Promise<string> => {
  const entry = declarativeBlockEntry({ componentId: 'x', label: 'X', source });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(createElement(entry.Component as any, props));
};

describe('declarative block format', () => {
  it('derives Puck fields + defaults from SCHEMA', async () => {
    const entry = declarativeBlockEntry({ componentId: 'hot_take', label: 'Hot Take', source: HOT_TAKE });
    expect(entry.componentId).toBe('hot_take');
    expect(entry.fields['title']?.type).toBe('text');
    expect(entry.fields['body']?.type).toBe('richtext');
    expect(entry.defaultProps['title']).toBe('');
  });

  it('renders bindings, static text, and rich text', async () => {
    const html = await renderEntry(HOT_TAKE, {
      title: 'Dodge-board',
      body: '<p>Logs are underrated</p>',
      poll_option_1_label: 'DASHBOARDS',
      poll_option_1_link: 'https://x/1',
      poll_option_2_label: 'CHAT',
      poll_option_2_link: 'https://x/2',
    });
    expect(html).toContain('HOT TAKE');
    expect(html).toContain('Dodge-board');
    expect(html).toContain('Logs are underrated');
    expect(html).toContain('DASHBOARDS');
    expect(html).toContain('CHAT');
    expect(html).toContain('https://x/1');
  });

  it('omits `if` blocks when the field is empty', async () => {
    const html = await renderEntry(HOT_TAKE, {
      title: '',
      body: '<p>x</p>',
      poll_option_1_label: '',
      poll_option_1_link: '',
      poll_option_2_label: '',
      poll_option_2_link: '',
    });
    expect(html).not.toContain('DASHBOARDS');
    expect(html).not.toContain('<h2'); // no heading when title empty
  });

  it('keeps an empty inline-editable `if` field visible in edit mode', async () => {
    // In the editor an empty <Heading if="title"> must still render so the
    // operator can click in and type — the `if` is a publish-time guard only.
    const html = await renderEntry(HOT_TAKE, {
      title: '',
      body: '<p>x</p>',
      poll_option_1_label: '',
      poll_option_1_link: '',
      poll_option_2_label: '',
      poll_option_2_link: '',
      editMode: true,
    });
    expect(html).toContain('<h1'); // title heading rendered (empty) for inline editing
  });

  it('still collapses an empty structural (array) `if` in edit mode', async () => {
    const ARRAY_GUARD = `
<!-- SCHEMA: { "items": {"type":"array","fields":{"title":{"type":"text"}}} } -->
<Section class="card">
  <Section if="items"><Text>HAS_ITEMS</Text></Section>
</Section>`;
    const html = await renderEntry(ARRAY_GUARD, { items: [], editMode: true });
    expect(html).not.toContain('HAS_ITEMS');
  });

  it('repeats `each` per array item', async () => {
    const html = await renderEntry(GENERIC, {
      heading: 'LINKS',
      useful_links: [
        { title: 'First', url: 'https://a' },
        { title: 'Second', url: 'https://b' },
      ],
    });
    expect(html).toContain('First');
    expect(html).toContain('Second');
    expect(html).toContain('https://a');
    expect(html).toContain('https://b');
  });

  it('exposes a slot field and renders its children', async () => {
    const SLOT = `
<!-- SCHEMA: { "children": {"type":"slot"} } -->
<Section class="card">
  <Text class="eyebrow">COMMUNITY</Text>
  <slot name="children" />
</Section>`;
    const entry = declarativeBlockEntry({ componentId: 'community', label: 'Community', source: SLOT });
    // entryHasSlot() looks for a `children` field of type 'slot'.
    expect(entry.fields['children']?.type).toBe('slot');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const html = await render(
      createElement(entry.Component as any, { children: createElement('div', null, 'BRICK_CONTENT') }),
    );
    expect(html).toContain('COMMUNITY');
    expect(html).toContain('BRICK_CONTENT');
  });

  it('only ever emits allowlisted components', async () => {
    // A non-allowlisted tag is dropped (its children survive); no script leaks.
    const html = await renderEntry(
      `<!-- SCHEMA: {} --><Section><script>alert(1)</script><evil onclick="x">hi</evil></Section>`,
      {},
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('hi');
  });
});
