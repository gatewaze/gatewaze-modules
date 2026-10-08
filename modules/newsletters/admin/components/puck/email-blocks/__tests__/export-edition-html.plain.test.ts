// @vitest-environment jsdom
/**
 * The built-in plain-email wrapper (lib/plain-email) through the export path.
 * jsdom because the declarative wrapper parser needs DOMParser; the
 * assertions themselves are on the HTML string the send stores.
 */
import { describe, expect, it } from 'vitest';
import { exportEditionHtml } from '../export-edition-html.js';
import type { NewsletterEdition } from '../../../../utils/types.js';
import type { BlockRenderMeta } from '../EditionEmail.js';
import { PLAIN_EMAIL_WRAPPER, PLAIN_SHELL_DIRECTIVE } from '../../../../../lib/plain-email/wrapper.js';

const baseEdition: NewsletterEdition = {
  id: 'ed-plain-1',
  edition_date: '2026-05-08',
  subject: 'Welcome',
  preheader: 'Hi from the test suite.',
  blocks: [
    { id: 'b-heading', block_template: { id: 'tpl-heading', name: 'Heading', block_type: 'heading', content: { html_template: '' } }, content: { text: 'Welcome', level: 'h1', align: 'center' }, sort_order: 1000, bricks: [] },
    { id: 'b-text', block_template: { id: 'tpl-text', name: 'Text', block_type: 'text', content: { html_template: '' } }, content: { body: '<p>Hello world. See the <a href="https://example.org/agenda">agenda</a>.</p>', align: 'left' }, sort_order: 2000, bricks: [] },
    { id: 'b-footer', block_template: { id: 'tpl-footer', name: 'Footer', block_type: 'footer', content: { html_template: '' } }, content: { footer_text: 'You are receiving this because you subscribed.', unsubscribe_text: '', unsubscribe_link: '' }, sort_order: 3000, bricks: [] },
  ],
};

describe('exportEditionHtml — plain email shell', () => {
  // The built-in plain wrapper (lib/plain-email) must come out like a message
  // typed in a mail client: no centred column, no font stack, no colours of
  // its own, left-aligned unsubscribe text, and colour-scheme metas so the
  // reader's client follows dark mode.
  const plainEdition = baseEdition;
  const plainMeta = new Map<string, BlockRenderMeta>([
    ['b-heading', { render_kind: 'react-email', component_id: 'heading' }],
    ['b-text', { render_kind: 'react-email', component_id: 'text' }],
    ['b-footer', { render_kind: 'react-email', component_id: 'footer' }],
  ]);

  it('drops the column, the font stack and the colours', async () => {
    // forSend: the unsubscribe line (with its anchors) is part of the output.
    const html = await exportEditionHtml({ edition: plainEdition, format: 'email', blockMeta: plainMeta, wrapperTemplate: PLAIN_EMAIL_WRAPPER, forSend: true });
    expect(html).toContain('Welcome');
    expect(html).toContain('Hello world.');
    expect(html).not.toMatch(/max-width:\s*600/i);
    expect(html).not.toMatch(/margin:\s*0\s*auto/i);
    expect(html).not.toMatch(/font-family/i);
    expect(html).not.toMatch(/color:\s*#/i);
    expect(html).not.toMatch(/text-align:\s*center/i);
    expect(html).not.toContain(PLAIN_SHELL_DIRECTIVE);
    // Links too: neither react-email Link's blue nor the rich-text brand blue.
    expect(html).toMatch(/<a href="https:\/\/example\.org\/agenda"/);
    expect(html).not.toMatch(/#067df7|#4086c6/i);
  });

  it('tells the client the email supports light and dark', async () => {
    const html = await exportEditionHtml({ edition: plainEdition, format: 'email', blockMeta: plainMeta, wrapperTemplate: PLAIN_EMAIL_WRAPPER });
    expect(html).toMatch(/<meta name="color-scheme" content="light dark"/);
    expect(html).toMatch(/<meta name="supported-color-schemes" content="light dark"/);
  });

  it('adds the unsubscribe line as plain text on a send render only', async () => {
    const sent = await exportEditionHtml({ edition: plainEdition, format: 'email', blockMeta: plainMeta, wrapperTemplate: PLAIN_EMAIL_WRAPPER, forSend: true });
    expect(sent).toMatch(/<a href="\{\{unsubscribe_url\}\}">Unsubscribe<\/a>/);
    // Only the one link, spaced off the message with line breaks.
    expect(sent).not.toContain('manage_subscriptions_url');
    expect(sent).toMatch(/(<br\s*\/?>\s*){3}<a href="\{\{unsubscribe_url\}\}"/);
    expect(sent.indexOf('Hello world.')).toBeLessThan(sent.indexOf('{{unsubscribe_url}}'));
    const web = await exportEditionHtml({ edition: plainEdition, format: 'email', blockMeta: plainMeta, wrapperTemplate: PLAIN_EMAIL_WRAPPER, forSend: false });
    expect(web).not.toContain('unsubscribe_url');
    expect(web).toContain('You are receiving this because you subscribed.');
  });

  it('leaves the standard shell untouched when no plain wrapper is given', async () => {
    const html = await exportEditionHtml({ edition: plainEdition, format: 'email', blockMeta: plainMeta });
    expect(html).toMatch(/max-width:\s*600/i);
    expect(html).not.toMatch(/<meta name="color-scheme"/);
  });
});
