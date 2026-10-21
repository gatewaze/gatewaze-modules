import { describe, expect, it } from 'vitest';
import { parseGoogleDocId, cleanDocHtml, buildFillPrompt, validateProposal, type FillTargetBlock, type FillLibraryBlock } from '../gdoc-fill.js';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';

describe('parseGoogleDocId', () => {
  it('reads the id from the usual Docs URLs and a bare id', () => {
    expect(parseGoogleDocId(`https://docs.google.com/document/d/${ID}/edit`)).toBe(ID);
    expect(parseGoogleDocId(`https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.1`)).toBe(ID);
    expect(parseGoogleDocId(`https://docs.google.com/document/u/1/d/${ID}/`)).toBe(ID);
    expect(parseGoogleDocId(`  ${ID}  `)).toBe(ID);
  });
  it('refuses other hosts, schemes and shapes', () => {
    expect(parseGoogleDocId(`http://docs.google.com/document/d/${ID}/edit`)).toBeNull();
    expect(parseGoogleDocId(`https://evil.example/document/d/${ID}/edit`)).toBeNull();
    expect(parseGoogleDocId(`https://docs.google.com.evil.example/document/d/${ID}`)).toBeNull();
    expect(parseGoogleDocId(`https://docs.google.com/spreadsheets/d/${ID}/edit`)).toBeNull();
    expect(parseGoogleDocId('short')).toBeNull();
    expect(parseGoogleDocId('')).toBeNull();
  });
});

describe('cleanDocHtml', () => {
  const exported = `<html><head><style>.c1{font-weight:700}.c2{font-style:italic}.c3{color:#000}</style></head>
<body class="doc"><h2 class="c3" id="h.x"><span class="c1 c3">TOP STORIES</span></h2>
<p class="c3"><span class="c1">Bold headline.</span> <span class="c2">Italic aside</span> and
<a class="c3" href="https://www.google.com/url?q=https://example.org/post?a%3D1&amp;sa=D&amp;source=editors">a link</a>.</p>
<p class="c3"><span class="c3"></span></p>
<script>alert(1)</script><img src="https://lh7-rt.googleusercontent.com/docsz/abc" style="width:10px"><img src="data:image/png;base64,xx"></body></html>`;
  const out = cleanDocHtml(exported);
  it('turns class-based bold and italic into tags and drops attributes', () => {
    expect(out).toContain('<h2><strong>TOP STORIES</strong></h2>');
    expect(out).toContain('<strong>Bold headline.</strong>');
    expect(out).toContain('<em>Italic aside</em>');
    expect(out).not.toMatch(/class=|style=|id=/);
  });
  it('unwraps Google redirect links and keeps https images only', () => {
    expect(out).toContain('<a href="https://example.org/post?a=1">a link</a>');
    expect(out).toContain('<img src="https://lh7-rt.googleusercontent.com/docsz/abc">');
    expect(out).not.toContain('data:image');
  });
  it('drops scripts and empty paragraphs', () => {
    expect(out).not.toContain('alert');
    expect(out).not.toMatch(/<p>\s*<\/p>/);
  });
});

const blocks: FillTargetBlock[] = [
  { id: '11111111-1111-4111-8111-111111111111', block_type: 'lead_commentary', name: 'Lead', schema: {
    title: { type: 'text' }, body: { type: 'richtext' }, read_more_url: { type: 'text', label: 'Read-more URL' },
  } },
  { id: '22222222-2222-4222-8222-222222222222', block_type: 'top_stories', name: 'Top Stories', schema: {
    eyebrow: { type: 'text', default: 'TOP STORIES' },
    items: { type: 'array', fields: { headline: { type: 'text' }, url: { type: 'text', label: 'Link' }, summary: { type: 'richtext' } } },
  } },
];
const library: FillLibraryBlock[] = [
  { block_type: 'finds', name: 'Finds', schema: { items: { type: 'array', fields: { headline: { type: 'text' } } } } },
  { block_type: 'top_stories', name: 'Top Stories', schema: blocks[1].schema },
];

describe('buildFillPrompt', () => {
  it('lists the edition blocks with their fields and offers only missing types', () => {
    const p = buildFillPrompt({ docHtml: '<p>doc</p>', blocks, library });
    expect(p).toContain('block_id "11111111-1111-4111-8111-111111111111"');
    expect(p).toContain('items (list of objects)');
    expect(p).toContain('type "finds"');
    expect(p.match(/type "top_stories"/g)?.length).toBe(1);
    expect(p).toContain('<p>doc</p>');
  });
});

describe('validateProposal', () => {
  it('keeps schema fields, coerces types and sanitises rich text', () => {
    const reply = '```json\n' + JSON.stringify({
      subject: '<b>Weekly</b> agentic',
      preheader: null,
      blocks: [
        { target_block_id: blocks[0].id, block_type: 'lead_commentary', source_heading: 'The lead',
          content: { title: '<i>Title</i>', body: '<p onclick="x()">Hi <a href="https://a.example">there</a><script>bad()</script></p>', read_more_url: 'javascript:alert(1)', bogus: 'dropped' } },
        { target_block_id: blocks[1].id, block_type: 'top_stories',
          content: { items: [{ headline: 'One', url: 'https://one.example/x', summary: '<p>S</p>', extra: 1 }, 'not an object', {}] } },
        { target_block_id: blocks[1].id, block_type: 'top_stories', content: { items: [{ headline: 'Dup' }] } },
        { target_block_id: 'not-a-block', block_type: 'lead_commentary', content: { title: 'x' } },
        { target_block_id: null, block_type: 'finds', content: { items: [{ headline: 'New block' }] } },
        { target_block_id: null, block_type: 'unknown_type', content: { a: 1 } },
      ],
      unmapped: [{ heading: 'Sponsor', reason: 'No sponsor block' }],
    }) + '\n```';
    const p = validateProposal(reply, blocks, library);
    expect(p.subject).toBe('Weekly agentic');
    expect(p.blocks).toHaveLength(3);
    const lead = p.blocks[0];
    expect(lead.content.title).toBe('Title');
    expect(lead.content.body).toMatch(/^<p>Hi <a href="https:\/\/a\.example" rel="noopener nofollow">there<\/a>\s*<\/p>$/);
    expect(lead.content).not.toHaveProperty('read_more_url');
    expect(lead.content).not.toHaveProperty('bogus');
    const stories = p.blocks[1].content.items as Array<Record<string, unknown>>;
    expect(stories).toEqual([{ headline: 'One', url: 'https://one.example/x', summary: '<p>S</p>' }]);
    expect(p.blocks[2]).toMatchObject({ target_block_id: null, block_type: 'finds' });
    expect(p.unmapped).toEqual([{ heading: 'Sponsor', reason: 'No sponsor block' }]);
  });
  it('drops script-like schemes in any text field and non-https images', () => {
    const lib: FillLibraryBlock[] = [{ block_type: 'cta', name: 'CTA', schema: { button_target: { type: 'text' }, image: { type: 'image' }, label: { type: 'text' } } }];
    const p = validateProposal(JSON.stringify({ blocks: [{ target_block_id: null, block_type: 'cta', content: { button_target: 'javascript:alert(1)', image: 'http://x.example/a.png', label: 'Go' } }] }), [], lib);
    expect(p.blocks[0].content).toEqual({ label: 'Go' });
  });
  it('throws on a reply that is not JSON', () => {
    expect(() => validateProposal('sorry, I cannot', blocks, library)).toThrow();
  });
});
