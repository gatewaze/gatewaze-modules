/**
 * Thumbs up/down feedback — two large buttons. Quick binary signal,
 * typically followed by an open-ended survey on the landing page.
 */

import { Column, Link, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ThumbsRatingProps extends Record<string, unknown> {
  prompt: string;
  positive_url: string;
  negative_url: string;
}

export const ThumbsRatingBlock: EmailBlockEntry<ThumbsRatingProps> = {
  componentId: 'thumbs_rating',
  label: 'Thumbs rating (feedback)',
  category: 'Feedback',
  fields: {
    prompt: { type: 'text', label: 'Prompt' },
    positive_url: { type: 'text', label: 'Positive (👍) URL' },
    negative_url: { type: 'text', label: 'Negative (👎) URL' },
  },
  defaultProps: {
    prompt: 'Was this helpful?',
    positive_url: 'https://example.com/feedback?score=up',
    negative_url: 'https://example.com/feedback?score=down',
  },
  Component: ({ prompt, positive_url, negative_url }) => (
    <Section style={{ padding: '24px 0', textAlign: 'center' }}>
      <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#111827' }}>{prompt}</Text>
      <Row>
        <Column style={{ width: '50%', textAlign: 'right', paddingRight: 12 }}>
          <Link
            href={positive_url}
            style={{ display: 'inline-block', padding: '8px 16px', backgroundColor: '#ECFDF5', color: '#065F46', borderRadius: 6, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}
          >
            👍 Yes
          </Link>
        </Column>
        <Column style={{ width: '50%', textAlign: 'left', paddingLeft: 12 }}>
          <Link
            href={negative_url}
            style={{ display: 'inline-block', padding: '8px 16px', backgroundColor: '#FEF2F2', color: '#991B1B', borderRadius: 6, fontSize: 14, fontWeight: 600, textDecoration: 'none' }}
          >
            👎 No
          </Link>
        </Column>
      </Row>
    </Section>
  ),
};
