/**
 * Hidden Gems — bordered card with a heading and a list of curated links,
 * each with a short description. Native react-email port of the legacy
 * `hidden_gems` Mustache block.
 */

import { Heading, Text, Link } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { Card } from './_card.js';
import { EYEBROW, TITLE, BODY, LINK } from './_shared.js';

interface Gem extends Record<string, unknown> {
  link_text: string;
  link_url: string;
  description?: string;
}

interface HiddenGemsProps extends Record<string, unknown> {
  title: string;
  gems: Gem[];
}

export const HiddenGemsBlock: EmailBlockEntry<HiddenGemsProps> = {
  componentId: 'hidden_gems',
  label: 'Hidden Gems',
  category: 'MLOps Template',
  fields: {
    title: { type: 'text', label: 'Title' },
    gems: {
      type: 'array',
      label: 'Gems',
      arrayFields: {
        link_text: { type: 'text', label: 'Link text' },
        link_url: { type: 'text', label: 'Link URL' },
        description: { type: 'text', label: 'Description' },
      },
      defaultItemProps: { link_text: '', link_url: '', description: '' },
    } as Field,
  },
  defaultProps: { title: 'Curated finds to help you stay ahead', gems: [] },
  Component: ({ title, gems }) => {
    const list = Array.isArray(gems) ? gems : [];
    return (
      <Card>
        <Text style={EYEBROW}>HIDDEN GEMS</Text>
        {title ? (
          <Heading as="h2" style={TITLE}>
            {title}
          </Heading>
        ) : null}
        {list.map((g, i) => (
          <Text key={i} style={{ ...BODY, margin: '0 0 14px' }}>
            <strong>
              <Link href={g.link_url} style={LINK}>
                {g.link_text}
              </Link>
            </strong>
            {g.description ? ` ${g.description}` : ''}
          </Text>
        ))}
      </Card>
    );
  },
};
