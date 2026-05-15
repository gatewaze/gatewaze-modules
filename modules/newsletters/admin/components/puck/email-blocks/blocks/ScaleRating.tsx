/**
 * 1–10 scale rating (NPS-style). Ten linked numbers — each opens the
 * survey URL with the value pre-filled.
 */

import { Link, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface ScaleRatingProps extends Record<string, unknown> {
  prompt: string;
  scale: '5' | '10';
  survey_url_template: string;
  accent_color: string;
}

export const ScaleRatingBlock: EmailBlockEntry<ScaleRatingProps> = {
  componentId: 'scale_rating',
  label: 'Scale rating (feedback)',
  category: 'Feedback',
  fields: {
    prompt: { type: 'text', label: 'Prompt' },
    scale: {
      type: 'select',
      label: 'Scale',
      options: [
        { label: '1–5', value: '5' },
        { label: '1–10', value: '10' },
      ],
    },
    // contentEditable disabled — render does `.replace('{value}', …)`
    // which needs a raw string; inline-edit wrap would turn it into an object.
    survey_url_template: {
      type: 'text',
      label: 'Survey URL template (use {value} for the score)',
      contentEditable: false,
    },
    accent_color: { type: 'text', label: 'Accent colour' },
  },
  defaultProps: {
    prompt: 'How likely are you to recommend us?',
    scale: '10',
    survey_url_template: 'https://example.com/nps?score={value}',
    accent_color: '#2563EB',
  },
  Component: ({ prompt, scale, survey_url_template, accent_color }) => {
    const max = scale === '5' ? 5 : 10;
    return (
      <Section style={{ padding: '24px 0', textAlign: 'center' }}>
        <Text style={{ margin: '0 0 12px', fontSize: 14, color: '#111827' }}>{prompt}</Text>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <Link
            key={n}
            href={survey_url_template.replace('{value}', String(n))}
            style={{
              display: 'inline-block',
              width: 34,
              height: 34,
              lineHeight: '34px',
              textAlign: 'center',
              borderRadius: 4,
              border: `1px solid ${accent_color}`,
              color: accent_color,
              textDecoration: 'none',
              fontSize: 14,
              fontWeight: 600,
              marginLeft: n === 1 ? 0 : 4,
            }}
          >
            {n}
          </Link>
        ))}
      </Section>
    );
  },
};
