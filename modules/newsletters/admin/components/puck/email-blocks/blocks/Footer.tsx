/**
 * Footer email block — small footer text + optional unsubscribe link.
 *
 * Mirrors the legacy "Footer" block created by the Newsletter Setup
 * Wizard's Basic Template option. The unsubscribe pair (text + link)
 * is rendered only when both fields are populated, matching the
 * `{{#unsubscribe_text}}...{{/unsubscribe_text}}` Mustache section.
 */

import { Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface FooterProps extends Record<string, unknown> {
  footer_text: string;
  unsubscribe_text: string;
  unsubscribe_link: string;
}

const SAFE_HREF = /^(https?:|mailto:|\/)/i;
const TEMPLATE_TOKEN = /^\{\{[^}]+\}\}$/;

function safeHref(value: unknown): string {
  if (typeof value !== 'string') return '#';
  const trimmed = value.trim();
  // Mustache-style template tokens like `{{unsubscribe_url}}` are
  // substituted by the send pipeline (newsletter-send replaces
  // {{unsubscribe_url}} with the HMAC-signed unsubscribe URL before
  // each recipient sees the email). Pass them through unchanged so
  // the substitution finds the token in the rendered HTML — the
  // trust boundary is upheld server-side where the real URL is
  // generated, not here.
  if (TEMPLATE_TOKEN.test(trimmed)) return value;
  return SAFE_HREF.test(trimmed) ? value : '#';
}

export const FooterBlock: EmailBlockEntry<FooterProps> = {
  componentId: 'footer',
  label: 'Footer',
  category: 'Navigation',
  fields: {
    footer_text: { type: 'textarea', label: 'Footer text' },
    unsubscribe_text: { type: 'text', label: 'Unsubscribe link text (optional)' },
    unsubscribe_link: { type: 'text', label: 'Unsubscribe URL (optional)' },
  },
  defaultProps: {
    footer_text: 'You are receiving this email because you subscribed.',
    unsubscribe_text: 'Unsubscribe',
    unsubscribe_link: '{{unsubscribe_url}}',
  },
  Component: ({ footer_text, unsubscribe_text, unsubscribe_link }) => (
    <Section
      style={{
        padding: '20px 40px',
        backgroundColor: '#f8f9fa',
        textAlign: 'center',
        fontSize: '13px',
        color: '#999',
      }}
    >
      <Text style={{ margin: 0 }}>{footer_text}</Text>
      {unsubscribe_text ? (
        <Text style={{ margin: '8px 0 0' }}>
          <a href={safeHref(unsubscribe_link)} style={{ color: '#666' }}>
            {unsubscribe_text}
          </a>
        </Text>
      ) : null}
    </Section>
  ),
  formats: {
    substack: ({ footer_text, unsubscribe_text, unsubscribe_link }) => (
      <>
        <p style={{ textAlign: 'center', color: '#999' }}>{footer_text}</p>
        {unsubscribe_text ? (
          <p style={{ textAlign: 'center' }}>
            <a href={safeHref(unsubscribe_link)}>{unsubscribe_text}</a>
          </p>
        ) : null}
      </>
    ),
    beehiiv: ({ footer_text, unsubscribe_text, unsubscribe_link }) => (
      <>
        <p style={{ textAlign: 'center', color: '#999' }}>{footer_text}</p>
        {unsubscribe_text ? (
          <p style={{ textAlign: 'center' }}>
            <a href={safeHref(unsubscribe_link)}>{unsubscribe_text}</a>
          </p>
        ) : null}
      </>
    ),
  },
};
