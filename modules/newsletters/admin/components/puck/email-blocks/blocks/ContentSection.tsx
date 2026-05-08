/**
 * Content Section email block — optional heading + rich-text body.
 *
 * Mirrors the legacy "Content Section" block created by the Newsletter
 * Setup Wizard's Basic Template option.
 *
 * `body` is a rich-text field (`format: 'html'`) — the editor renders
 * the TipTap-based RichTextField for it, the renderer emits the
 * resulting HTML inside `<Text>` via `dangerouslySetInnerHTML`. Per
 * spec-builder-evaluation §3.4.
 */

import { Heading, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ContentSectionProps extends Record<string, unknown> {
  title: string;
  body: string;
}

export const ContentSectionBlock: EmailBlockEntry<ContentSectionProps> = {
  componentId: 'content_section',
  label: 'Content Section',
  category: 'Content',
  fields: {
    title: { type: 'text', label: 'Section title (optional)' },
    body: { type: 'custom', label: 'Body', customFormat: 'richtext' },
  },
  defaultProps: {
    title: '',
    body: '<p>Write your content here.</p>',
  },
  Component: ({ title, body }) => (
    <Section style={{ padding: '20px 40px' }}>
      {title ? (
        <Heading as="h2" style={{ fontSize: '22px', fontWeight: 'bold', color: '#1a1a2e', margin: '0 0 16px' }}>
          {title}
        </Heading>
      ) : null}
      <div
        style={{ fontSize: '16px', lineHeight: 1.6, color: '#333' }}
        dangerouslySetInnerHTML={{ __html: typeof body === 'string' ? body : '' }}
      />
    </Section>
  ),
  formats: {
    substack: ({ title, body }) => (
      <>
        {title ? <h2>{title}</h2> : null}
        <div dangerouslySetInnerHTML={{ __html: body ?? '' }} />
      </>
    ),
    beehiiv: ({ title, body }) => (
      <>
        {title ? <h2>{title}</h2> : null}
        <div dangerouslySetInnerHTML={{ __html: body ?? '' }} />
      </>
    ),
  },
};
