/**
 * Hero composite — hero image + heading + subheading + CTA button.
 *
 * Mirrors the central "welcome to {brand}" panel in the Barebone
 * `welcome.tsx` template (rounded card with image, eyebrow, big
 * heading, body text, button). One drop-in block instead of
 * Section + Img + Heading + Text + Button stitched manually.
 */

import { Button, Heading, Img, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface HeroProps extends Record<string, unknown> {
  image_url: string;
  eyebrow: string;
  title: string;
  body: string;
  cta_label: string;
  cta_url: string;
  background: string;
}

export const HeroBlock: EmailBlockEntry<HeroProps> = {
  componentId: 'hero',
  label: 'Hero',
  category: 'Introduction',
  fields: {
    image_url: {
      type: 'custom',
      label: 'Image (optional)',
      render: NewsletterImageFieldAdapter as never,
    },
    // contentEditable: true makes Puck's getInlineTextTransform wrap
    // these values in <InlineTextField> spans so the operator can edit
    // them directly on the canvas. The component renders each value
    // as children of its react-email element (NOT via
    // dangerouslySetInnerHTML) which is what the transform requires.
    eyebrow: { type: 'text', label: 'Eyebrow (small text above title)', contentEditable: true },
    title: { type: 'text', label: 'Title', contentEditable: true },
    body: { type: 'textarea', label: 'Body', contentEditable: true },
    cta_label: { type: 'text', label: 'CTA button label', contentEditable: true },
    cta_url: { type: 'text', label: 'CTA URL' },
    background: { type: 'text', label: 'Background colour' },
  },
  defaultProps: {
    image_url: '',
    eyebrow: 'Welcome',
    title: 'Hello, world',
    body: 'A short, persuasive paragraph that introduces this edition.',
    cta_label: 'Read more',
    cta_url: 'https://example.com',
    background: '#F3F4F6',
  },
  Component: ({ image_url, eyebrow, title, body, cta_label, cta_url, background }) => (
    <Section style={{ padding: '40px 32px', backgroundColor: background, borderRadius: 10, textAlign: 'center' }}>
      {image_url ? (
        <Img
          src={image_url}
          alt=""
          width={520}
          style={{ display: 'block', margin: '0 auto 24px', maxWidth: '100%', height: 'auto', borderRadius: 12 }}
        />
      ) : null}
      {eyebrow ? (
        <Text style={{ margin: '0 0 8px', fontSize: 13, color: '#7B7D81' }}>{eyebrow}</Text>
      ) : null}
      <Heading as="h1" style={{ margin: '0 0 16px', fontSize: 32, fontWeight: 600, color: '#14171E', lineHeight: 1.25 }}>
        {title}
      </Heading>
      <Text style={{ margin: '0 0 24px', fontSize: 16, color: '#43454B', lineHeight: 1.6 }}>{body}</Text>
      {cta_label && cta_url ? (
        <Button
          href={cta_url}
          style={{ display: 'inline-block', backgroundColor: '#14171E', color: '#fff', padding: '14px 28px', borderRadius: 8, fontSize: 16, lineHeight: '1.5' }}
        >
          {cta_label}
        </Button>
      ) : null}
    </Section>
  ),
};
