/**
 * Email-only Intro — identical visual treatment to IntroParagraph, but the
 * portal /View Online/ page filters any block whose `block_type` starts
 * with `email_only_` so its content NEVER reaches the public web.
 *
 * Use cases:
 *   - Apology / correction headers on a re-send (the original prompt to
 *     add this — 2026-06-24, after the 56k mlopscommunity send shipped
 *     without the body block).
 *   - Email-client-specific calls to action ("reply to this email…")
 *     that don't make sense as part of an archived public article.
 *   - Anything else that should live in the inbox but not the archive.
 *
 * The portal filter is keyed on the `block_type` prefix `email_only_`
 * (not on the templates_block_defs row), so any future block with that
 * naming convention is automatically filtered without an additional code
 * change.
 */

import { Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { COLUMN } from './_shared.js';

interface EmailOnlyIntroProps extends Record<string, unknown> {
  text: string;
}

export const EmailOnlyIntroBlock: EmailBlockEntry<EmailOnlyIntroProps> = {
  componentId: 'email_only_intro',
  label: 'Email-only Intro (not shown on portal)',
  category: 'MLOps Template',
  fields: {
    text: { type: 'richtext', label: 'Email-only Intro Text' },
  },
  defaultProps: { text: '' },
  Component: ({ text }) => (
    <Section style={COLUMN}>
      <RichText
        value={text}
        style={{
          fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
          fontSize: '20px',
          lineHeight: 1.5,
          color: '#555',
          padding: '20px 15px',
        }}
      />
    </Section>
  ),
};
