/**
 * Star-rating feedback — five clickable stars that link to a survey
 * with the rating pre-selected. Common at the end of transactional
 * emails ("How was your experience?").
 */

import { Link, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface StarRatingProps extends Record<string, unknown> {
  prompt: string;
  survey_url_template: string;
  star_color: string;
}

export const StarRatingBlock: EmailBlockEntry<StarRatingProps> = {
  componentId: 'star_rating',
  label: 'Star rating (feedback)',
  category: 'Feedback',
  fields: {
    prompt: { type: 'text', label: 'Prompt' },
    // contentEditable disabled — render does `.replace('{rating}', …)`
    // which needs a raw string; inline-edit wrap would turn it into an object.
    survey_url_template: {
      type: 'text',
      label: 'Survey URL template (use {rating} for the value)',
      contentEditable: false,
    },
    star_color: { type: 'text', label: 'Star colour' },
  },
  defaultProps: {
    prompt: 'How was your experience?',
    survey_url_template: 'https://example.com/feedback?rating={rating}',
    star_color: '#F59E0B',
  },
  Component: ({ prompt, survey_url_template, star_color }) => (
    <Section style={{ padding: '24px 0', textAlign: 'center' }}>
      <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#111827' }}>{prompt}</Text>
      {[1, 2, 3, 4, 5].map((n) => (
        <Link
          key={n}
          href={survey_url_template.replace('{rating}', String(n))}
          style={{ fontSize: 32, color: star_color, textDecoration: 'none', marginLeft: n === 1 ? 0 : 8, lineHeight: '1' }}
        >
          ★
        </Link>
      ))}
    </Section>
  ),
};
