/**
 * Content Section email block — optional heading + rich-text body.
 *
 * Mirrors the legacy "Content Section" block created by the Newsletter
 * Setup Wizard's Basic Template option.
 *
 * The `body` prop is a string that the renderer drops into the email
 * via `dangerouslySetInnerHTML`, so it accepts either plain text or
 * HTML markup. The field type is `textarea` — operators paste HTML
 * directly or type plain text. (The earlier `type: 'custom' +
 * customFormat: 'richtext'` declaration relied on a customFormat→render
 * resolver that the email-blocks merge layer doesn't run — sites'
 * PuckConfigAdapter does it but newsletters' mergeRegistryIntoConfig
 * never wired up the same step, so Puck saw a custom field with no
 * `render` and threw "Field type for custom did not exist." Pending
 * the rich-text editor work that's parked, textarea is the safe shape.)
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
    // contentEditable disabled — body is rendered via dangerouslySetInnerHTML
    // which requires a raw string for __html. The inline-edit wrapper would
    // make `typeof body === 'string'` false and the body would render empty.
    body: { type: 'textarea', label: 'Body (HTML accepted)', contentEditable: false },
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
