/**
 * Generic — a catch-all card with an EDITABLE heading (eyebrow), title,
 * rich-text body, and optional "Useful links". A copy of the Agent
 * Infrastructure block whose eyebrow label is editable, so it can be used for
 * any section that doesn't have a dedicated block yet.
 *
 * (Distinct from `generic_section`, which is the community brick rendered
 * inside the MLOps Community slot.)
 */

import { Heading, Text, Hr, Link } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { Card } from './_card.js';
import { EYEBROW, TITLE, BODY, LINK } from './_shared.js';

interface UsefulLink extends Record<string, unknown> {
  title: string;
  url: string;
  description?: string;
}

interface GenericProps extends Record<string, unknown> {
  heading: string;
  title: string;
  body: string;
  useful_links: UsefulLink[];
}

export const GenericBlock: EmailBlockEntry<GenericProps> = {
  componentId: 'generic',
  label: 'Generic',
  category: 'MLOps Template',
  fields: {
    heading: { type: 'text', label: 'Heading (eyebrow)' },
    title: { type: 'text', label: 'Title' },
    body: { type: 'richtext', label: 'Body' },
    useful_links: {
      type: 'array',
      label: 'Useful links',
      arrayFields: {
        title: { type: 'text', label: 'Link title' },
        url: { type: 'text', label: 'URL' },
        description: { type: 'text', label: 'Description' },
      },
      defaultItemProps: { title: '', url: '', description: '' },
    } as Field,
  },
  defaultProps: { heading: 'Section', title: '', body: '', useful_links: [] },
  Component: ({ heading, title, body, useful_links }) => {
    const links = Array.isArray(useful_links) ? useful_links : [];
    return (
      <Card>
        <Text style={EYEBROW}>{heading || 'Section'}</Text>
        {title ? (
          <Heading as="h2" style={TITLE}>
            {title}
          </Heading>
        ) : null}
        <RichText value={body} style={BODY} />
        {links.length > 0 ? (
          <>
            <Hr style={{ border: 0, borderTop: '1px solid #bbb', margin: '16px 0' }} />
            <Heading as="h3" style={{ margin: '0 0 8px', fontSize: '24px', fontWeight: 'bold', color: '#000' }}>
              Useful links
            </Heading>
            {links.map((l, i) => (
              <Text key={i} style={{ ...BODY, margin: '0 0 12px' }}>
                <strong>
                  <Link href={l.url} style={LINK}>
                    {l.title}
                  </Link>
                </strong>
                {l.description ? ` – ${l.description}` : ''}
              </Text>
            ))}
          </>
        ) : null}
      </Card>
    );
  },
};
