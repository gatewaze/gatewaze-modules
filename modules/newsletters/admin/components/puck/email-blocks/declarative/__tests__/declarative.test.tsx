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

  it('passes a React-node binding value through (Puck inline editor)', async () => {
    // In the canvas Puck replaces a contentEditable field's string with an
    // editor node; a whole-value {{binding}} must render that node, not
    // String() it to "[object Object]".
    const TEXT = `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading>{{title}}</Heading></Section>`;
    const editorNode = createElement('span', { 'data-inline-editor': 'on' }, 'EDIT_ME');
    const html = await renderEntry(TEXT, { title: editorNode });
    expect(html).toContain('data-inline-editor');
    expect(html).toContain('EDIT_ME');
    expect(html).not.toContain('[object Object]');
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

  describe('html attribute (inline-html in text fields)', () => {
    it('renders sanitised inline tags from a bound text field', async () => {
      const html = await renderEntry(
        `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading if="title" html>{{title}}</Heading></Section>`,
        { title: 'New <s>old</s> price' },
      );
      expect(html).toContain('<s>old</s>');
      expect(html).toContain('New ');
      expect(html).toContain('price');
    });

    it('aliases <strike>, <del>, <ins> alongside <s> (admin muscle-memory)', async () => {
      // The user typed <strike>multiple</strike> agents — pre-alias the strike
      // got dropped and the title rendered as plain text. Now all three keep
      // their tag.
      for (const tag of ['strike', 'del', 'ins'] as const) {
        const html = await renderEntry(
          `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading if="title" html>{{title}}</Heading></Section>`,
          { title: `keep <${tag}>x</${tag}> end` },
        );
        expect(html).toContain(`<${tag}>x</${tag}>`);
        expect(html).toContain('end');
      }
    });

    it('strips non-allowlisted tags but keeps text', async () => {
      const html = await renderEntry(
        `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading if="title" html>{{title}}</Heading></Section>`,
        { title: 'safe <script>alert(1)</script> and <img onerror="x"> text' },
      );
      expect(html).not.toContain('<script');
      expect(html).not.toContain('alert(1)');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('onerror');
      // The text outside the stripped tags survives.
      expect(html).toContain('safe ');
      expect(html).toContain(' text');
    });

    it('strips attributes from allowlisted tags (no onclick smuggling)', async () => {
      const html = await renderEntry(
        `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading if="title" html>{{title}}</Heading></Section>`,
        { title: '<em class="x" onclick="alert(1)">x</em>' },
      );
      expect(html).toContain('<em>x</em>');
      expect(html).not.toContain('onclick');
      expect(html).not.toContain('class=');
    });

    it('renders Puck inline-editor React-node value as children (canvas keeps inline-edit)', async () => {
      // The html-attribute path defers to the React node when present so
      // Puck's contentEditable continues to host the inline editor in
      // the canvas. Stringifying it would print "[object Object]" in the
      // heading (2026-06-25 bug); an earlier attempt at text extraction
      // produced empty `<h1></h1>` for plugin layouts whose .props.children
      // didn't expose simple text — title disappeared entirely. The safe
      // default keeps the editor visible; published render uses
      // dangerouslySetInnerHTML via the string-value path below.
      const TEXT = `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading html>{{title}}</Heading></Section>`;
      const editorNode = createElement('span', { 'data-inline-editor': 'on' }, 'EDIT_ME');
      const entry = declarativeBlockEntry({ componentId: 'x', label: 'X', source: TEXT });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const html = await render(createElement(entry.Component as any, { title: editorNode }));
      expect(html).toContain('data-inline-editor');
      expect(html).toContain('EDIT_ME');
      expect(html).not.toContain('[object Object]');
    });

    it('without the html attribute the same source renders tags as literal text', async () => {
      const html = await renderEntry(
        `<!-- SCHEMA: { "title": {"type":"text"} } --><Section><Heading if="title">{{title}}</Heading></Section>`,
        { title: 'New <s>old</s> price' },
      );
      // Bound through resolveBindings → text children → React escapes <s>.
      expect(html).toContain('&lt;s&gt;');
      expect(html).not.toContain('<s>');
    });
  });

  it('preserves children of <Link> even though <link> is HTML5-void', async () => {
    // Regression: DOMParser lowercases <Link> to <link>, treats it as void,
    // and drops the inner content. The parser must rewrite the collision
    // before parsing so the anchor's children survive end-to-end.
    const html = await renderEntry(
      `<!-- SCHEMA: { "url": {"type":"text"} } --><Section><Link href="{{url}}">Click here</Link></Section>`,
      { url: 'https://example.com/' },
    );
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('Click here');
    // The crucial assertion: the link text must be INSIDE an anchor, not
    // floating as a sibling text node after an empty <a>.
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com\/"[^>]*>[^<]*Click here[^<]*<\/a>/);
  });

  describe('safe URL encoding on src/href (Gmail-safe)', () => {
    // Defence-in-depth for the upload-time slugifier: even if a legacy
    // upload, manual DB edit, or AI-generated content puts a literal-space
    // URL into a field, the renderer must emit a properly-encoded URL so
    // mail clients (Gmail) will load the image / follow the link.
    it('encodes spaces in {{url}} bindings on src and href', async () => {
      const SRC_HREF = `
<!-- SCHEMA: { "img_url": {"type":"text"}, "link_url": {"type":"text"} } -->
<Section>
  <Img src="{{img_url}}" alt="" />
  <Link href="{{link_url}}">Click</Link>
</Section>`;
      const html = await renderEntry(SRC_HREF, {
        img_url: 'https://cdn.example.com/path/The RePPIT framework.png',
        link_url: 'https://example.com/some page?ok=1',
      });
      expect(html).toContain('src="https://cdn.example.com/path/The%20RePPIT%20framework.png"');
      expect(html).toContain('href="https://example.com/some%20page?ok=1"');
      // No literal spaces inside src/href values.
      expect(html).not.toMatch(/src="[^"]* [^"]*"/);
      expect(html).not.toMatch(/href="[^"]* [^"]*"/);
    });

    it('leaves already-encoded URLs alone (no double-encoding)', async () => {
      const SRC = `<!-- SCHEMA: { "url": {"type":"text"} } --><Section><Img src="{{url}}" alt="" /></Section>`;
      const html = await renderEntry(SRC, {
        url: 'https://cdn.example.com/path/the%20file.png',
      });
      expect(html).toContain('src="https://cdn.example.com/path/the%20file.png"');
      expect(html).not.toContain('the%2520file.png');
    });
  });
});
