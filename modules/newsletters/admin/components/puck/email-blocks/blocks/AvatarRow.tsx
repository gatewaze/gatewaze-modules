/**
 * Avatar row — five horizontally-arranged avatars. "Team" / "joined
 * this week" / contributor lineup.
 */

import { Img, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface AvatarRowProps extends Record<string, unknown> {
  caption: string;
  a1_url: string;
  a2_url: string;
  a3_url: string;
  a4_url: string;
  a5_url: string;
  size: string;
}

export const AvatarRowBlock: EmailBlockEntry<AvatarRowProps> = {
  componentId: 'avatar_row',
  label: 'Avatar row',
  category: 'Avatars',
  fields: {
    caption: { type: 'text', label: 'Caption (optional)' },
    a1_url: { type: 'custom', label: 'Avatar 1', render: NewsletterImageFieldAdapter as never },
    a2_url: { type: 'custom', label: 'Avatar 2', render: NewsletterImageFieldAdapter as never },
    a3_url: { type: 'custom', label: 'Avatar 3', render: NewsletterImageFieldAdapter as never },
    a4_url: { type: 'custom', label: 'Avatar 4', render: NewsletterImageFieldAdapter as never },
    a5_url: { type: 'custom', label: 'Avatar 5', render: NewsletterImageFieldAdapter as never },
    size: { type: 'text', label: 'Size (px)' },
  },
  defaultProps: {
    caption: 'Joined this week',
    a1_url: '',
    a2_url: '',
    a3_url: '',
    a4_url: '',
    a5_url: '',
    size: '40',
  },
  Component: ({ caption, a1_url, a2_url, a3_url, a4_url, a5_url, size }) => {
    const px = Number(size) || 40;
    const urls = [a1_url, a2_url, a3_url, a4_url, a5_url].filter((u) => u);
    return (
      <Section style={{ padding: '20px 0', textAlign: 'center' }}>
        {urls.map((url, i) => (
          <Img
            key={`${url}-${i}`}
            src={url}
            alt=""
            width={px}
            height={px}
            style={{
              borderRadius: px / 2,
              display: 'inline-block',
              border: '2px solid #FFFFFF',
              marginLeft: i === 0 ? 0 : -10,
              verticalAlign: 'middle',
            }}
          />
        ))}
        {caption ? (
          <Text style={{ margin: '12px 0 0', fontSize: 12, color: '#6B7280' }}>{caption}</Text>
        ) : null}
      </Section>
    );
  },
};
