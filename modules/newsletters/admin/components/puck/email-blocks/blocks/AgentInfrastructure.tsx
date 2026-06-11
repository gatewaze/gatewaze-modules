/**
 * Agent Infrastructure — deep-dive card with a rich-text body and an optional
 * "Useful links" list. Native react-email port of the legacy
 * `agent_infrastructure` Mustache block.
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

interface AgentInfraProps extends Record<string, unknown> {
  title: string;
  body: string;
  useful_links: UsefulLink[];
}

export const AgentInfrastructureBlock: EmailBlockEntry<AgentInfraProps> = {
  componentId: 'agent_infrastructure',
  label: 'Agent Infrastructure',
  category: 'Content',
  fields: {
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
  defaultProps: { title: '', body: '', useful_links: [] },
  Component: ({ title, body, useful_links }) => {
    const links = Array.isArray(useful_links) ? useful_links : [];
    return (
      <Card>
        <Text style={EYEBROW}>AGENT INFRASTRUCTURE</Text>
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
