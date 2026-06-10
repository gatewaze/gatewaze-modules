/**
 * Sponsored Ad — bordered card with a "presented by" label, headline,
 * optional image, rich-text body, and optional CTA. Native react-email port
 * of the legacy `sponsored_ad` Mustache block.
 */

import { Section, Heading, Text, Img, Link } from '@react-email/components';
import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { normalizeRichText } from '../rich-text.js';
import { BORDERED_CARD, EYEBROW, BODY, LINK } from './_shared.js';

interface SponsoredAdProps extends Record<string, unknown> {
  sponsor_name: string;
  headline: string;
  image_url: string;
  image_link: string;
  body: string;
  cta_text: string;
  cta_link: string;
}

export const SponsoredAdBlock: EmailBlockEntry<SponsoredAdProps> = {
  componentId: 'sponsored_ad',
  label: 'Sponsored Ad',
  category: 'Content',
  fields: {
    sponsor_name: { type: 'text', label: 'Sponsor name' },
    headline: { type: 'text', label: 'Headline' },
    image_url: { type: 'text', label: 'Image URL' },
    image_link: { type: 'text', label: 'Image click link' },
    body: { type: 'custom', customFormat: 'richtext', label: 'Body' } as Field,
    cta_text: { type: 'text', label: 'CTA text' },
    cta_link: { type: 'text', label: 'CTA link' },
  },
  defaultProps: {
    sponsor_name: '',
    headline: '',
    image_url: '',
    image_link: '',
    body: '',
    cta_text: '',
    cta_link: '',
  },
  Component: ({ sponsor_name, headline, image_url, image_link, body, cta_text, cta_link }) => (
    <Section style={BORDERED_CARD}>
      <Text style={{ ...EYEBROW, textTransform: 'uppercase' }}>PRESENTED BY {sponsor_name}</Text>
      {headline ? (
        <Heading as="h2" style={{ margin: '0 0 10px', fontSize: '23px', fontWeight: 'bold', color: '#555', lineHeight: 1.2 }}>
          {headline}
        </Heading>
      ) : null}
      {image_url ? (
        <Link href={image_link || '#'}>
          <Img
            src={image_url}
            alt=""
            style={{ display: 'block', width: '100%', maxWidth: '100%', height: 'auto', border: 0 }}
          />
        </Link>
      ) : null}
      <div style={{ ...BODY, marginTop: '12px' }} dangerouslySetInnerHTML={{ __html: normalizeRichText(body) }} />
      {cta_text ? (
        <Text style={{ ...BODY, marginTop: '12px' }}>
          <strong>
            <Link href={cta_link} style={LINK}>
              {cta_text}
            </Link>
          </strong>
        </Text>
      ) : null}
    </Section>
  ),
};
