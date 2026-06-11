/**
 * Newsletter Header — Shop // View Online links, date, and a "forwarded?
 * subscribe" line. Native react-email port of the legacy `header` Mustache
 * block. Uses componentId 'newsletter_header' (the registry already has a
 * generic 'header'); the migrate script renames the block_type accordingly.
 */

import type { CSSProperties } from 'react';
import { Section, Text, Link } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { COLUMN, LINK } from './_shared.js';

interface NewsletterHeaderProps extends Record<string, unknown> {
  shop_link: string;
  subscribe_link: string;
  edition_date: string;
  view_online_link: string;
}

const CENTER: CSSProperties = { margin: 0, textAlign: 'center', fontSize: '14px', color: '#4086c6' };

export const NewsletterHeaderBlock: EmailBlockEntry<NewsletterHeaderProps> = {
  componentId: 'newsletter_header',
  label: 'Newsletter Header',
  category: 'MLOps Template',
  fields: {
    shop_link: { type: 'text', label: 'Shop link' },
    view_online_link: { type: 'text', label: 'View online link' },
    edition_date: { type: 'text', label: 'Edition date' },
    subscribe_link: { type: 'text', label: 'Subscribe link' },
  },
  defaultProps: {
    shop_link: 'https://go.mlops.community/NL_Shop',
    view_online_link: '#',
    edition_date: '',
    subscribe_link: 'https://go.mlops.community/NL_Sub_Here',
  },
  Component: ({ shop_link, view_online_link, edition_date, subscribe_link }) => (
    <Section style={COLUMN}>
      <div style={{ padding: '15px 0' }}>
      <Text style={{ ...CENTER, fontSize: '16px' }}>
        <Link href={shop_link} style={LINK}>
          Shop
        </Link>
        {' // '}
        <Link href={view_online_link || '#'} style={LINK}>
          View Online
        </Link>
      </Text>
      {edition_date ? <Text style={{ ...CENTER, marginTop: '8px' }}>{edition_date}</Text> : null}
      <Text style={{ ...CENTER, fontSize: '12px', marginTop: '8px' }}>
        Forwarded this email?{' '}
        <Link href={subscribe_link} style={LINK}>
          Subscribe here
        </Link>
      </Text>
      </div>
    </Section>
  ),
};
