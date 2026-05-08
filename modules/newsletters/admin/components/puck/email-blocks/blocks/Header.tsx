/**
 * Header email block — title + optional subtitle, hero-style.
 *
 * Mirrors the legacy "Header" block created by the Newsletter Setup
 * Wizard's Basic Template option, ported to react-email primitives.
 * Per spec-builder-evaluation §3.6 (extended).
 */

import { Heading, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface HeaderProps extends Record<string, unknown> {
  title: string;
  subtitle: string;
}

export const HeaderBlock: EmailBlockEntry<HeaderProps> = {
  componentId: 'header',
  label: 'Header',
  category: 'Navigation',
  fields: {
    title: { type: 'text', label: 'Title' },
    subtitle: { type: 'text', label: 'Subtitle (optional)' },
  },
  defaultProps: {
    title: 'Newsletter title',
    subtitle: '',
  },
  Component: ({ title, subtitle }) => (
    <Section style={{ padding: '30px 40px', backgroundColor: '#f8f9fa', textAlign: 'center' }}>
      <Heading as="h1" style={{ margin: 0, fontSize: '28px', fontWeight: 'bold', color: '#1a1a2e' }}>
        {title}
      </Heading>
      {subtitle ? (
        <Text style={{ margin: '8px 0 0', fontSize: '16px', color: '#666' }}>{subtitle}</Text>
      ) : null}
    </Section>
  ),
  formats: {
    substack: ({ title, subtitle }) => (
      <>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </>
    ),
    beehiiv: ({ title, subtitle }) => (
      <>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </>
    ),
  },
};
