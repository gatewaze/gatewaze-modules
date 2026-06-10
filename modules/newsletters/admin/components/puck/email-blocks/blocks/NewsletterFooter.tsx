/**
 * Newsletter Footer — partner contact line + social links. Native react-email
 * port of the legacy `footer` Mustache block. Uses componentId
 * 'newsletter_footer' (the registry already has a generic 'footer'); the
 * migrate script renames the block_type accordingly.
 */

import type { CSSProperties } from 'react';
import { Section, Text, Link } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { COLUMN, LINK } from './_shared.js';

interface NewsletterFooterProps extends Record<string, unknown> {
  partner_email: string;
  slack_link: string;
  youtube_link: string;
  podcast_link: string;
  x_link: string;
  linkedin_link: string;
}

const CENTER: CSSProperties = {
  margin: '0 0 12px',
  textAlign: 'center',
  fontSize: '14px',
  color: '#555',
  lineHeight: 1.4,
};

export const NewsletterFooterBlock: EmailBlockEntry<NewsletterFooterProps> = {
  componentId: 'newsletter_footer',
  label: 'Newsletter Footer',
  category: 'Layout',
  fields: {
    partner_email: { type: 'text', label: 'Partner email' },
    slack_link: { type: 'text', label: 'Slack link' },
    youtube_link: { type: 'text', label: 'YouTube link' },
    podcast_link: { type: 'text', label: 'Podcast link' },
    x_link: { type: 'text', label: 'X / Twitter link' },
    linkedin_link: { type: 'text', label: 'LinkedIn link' },
  },
  defaultProps: {
    partner_email: 'partners@mlops.community',
    slack_link: 'https://go.mlops.community/NL_Slack_Invite',
    youtube_link: 'https://go.mlops.community/NL_YouTube_Channel',
    podcast_link: 'https://go.mlops.community/NL_Gradual_Content',
    x_link: 'https://go.mlops.community/NL_X_Homepage',
    linkedin_link: 'https://go.mlops.community/NL_LinkedIn',
  },
  Component: ({ partner_email, slack_link, youtube_link, podcast_link, x_link, linkedin_link }) => (
    <Section style={{ ...COLUMN, padding: '10px 0' }}>
      <Text style={CENTER}>Interested in partnering with us? Get in touch: {partner_email}</Text>
      <Text style={CENTER}>
        Thanks for reading. See you in{' '}
        <Link href={slack_link} style={LINK}>
          Slack
        </Link>
        ,{' '}
        <Link href={youtube_link} style={LINK}>
          YouTube
        </Link>
        , and{' '}
        <Link href={podcast_link} style={LINK}>
          podcast
        </Link>{' '}
        land. Oh yeah, and we are also on{' '}
        <Link href={x_link} style={LINK}>
          X
        </Link>{' '}
        and{' '}
        <Link href={linkedin_link} style={LINK}>
          LinkedIn
        </Link>
        .
      </Text>
    </Section>
  ),
};
