/**
 * Hot Take — bordered card with a heading + rich-text body and an optional
 * two-button poll attached beneath. Native react-email port of the legacy
 * `hot_take` Mustache block.
 */

import { Section, Row, Column, Heading, Text, Button } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { RichText } from './_richtext.js';
import { COLUMN, EYEBROW, TITLE, BODY } from './_shared.js';

interface HotTakeProps extends Record<string, unknown> {
  title: string;
  body: string;
  poll_option_1_label: string;
  poll_option_1_link: string;
  poll_option_2_label: string;
  poll_option_2_link: string;
}

const POLL_BUTTON = {
  backgroundColor: '#4086c6',
  borderRadius: '4px',
  color: '#ffffff',
  fontSize: '16px',
  fontWeight: 'bold' as const,
  padding: '5px 20px',
  textDecoration: 'none',
  textAlign: 'center' as const,
};

export const HotTakeBlock: EmailBlockEntry<HotTakeProps> = {
  componentId: 'hot_take',
  label: 'Hot Take',
  category: 'MLOps Template',
  fields: {
    title: { type: 'text', label: 'Title' },
    body: { type: 'richtext', label: 'Body' },
    poll_option_1_label: { type: 'text', label: 'Poll option 1 label' },
    poll_option_1_link: { type: 'text', label: 'Poll option 1 link' },
    poll_option_2_label: { type: 'text', label: 'Poll option 2 label' },
    poll_option_2_link: { type: 'text', label: 'Poll option 2 link' },
  },
  defaultProps: {
    title: '',
    body: '',
    poll_option_1_label: '',
    poll_option_1_link: '',
    poll_option_2_label: '',
    poll_option_2_link: '',
  },
  Component: ({
    title,
    body,
    poll_option_1_label,
    poll_option_1_link,
    poll_option_2_label,
    poll_option_2_link,
  }) => {
    const hasPoll = Boolean(poll_option_1_label);
    return (
      <>
        <Section
          style={{
            ...COLUMN,
            // When a poll is attached, the body and poll are one visual card:
            // drop the inter-block gap so the poll sits flush beneath.
            marginBottom: hasPoll ? 0 : '20px',
            borderCollapse: 'separate',
            borderLeft: '1px solid #4086c6',
            borderRight: '1px solid #4086c6',
            borderTop: '1px solid #4086c6',
            borderBottom: hasPoll ? 'none' : '1px solid #4086c6',
            borderRadius: hasPoll ? '15px 15px 0 0' : '15px',
            color: '#000',
          }}
        >
          <div style={{ padding: '15px 15px 5px' }}>
            <Text style={EYEBROW}>HOT TAKE</Text>
            {title ? (
              <Heading as="h2" style={TITLE}>
                {title}
              </Heading>
            ) : null}
            <RichText value={body} style={BODY} />
          </div>
        </Section>
        {hasPoll ? (
          <Section
            style={{
              ...COLUMN,
              borderCollapse: 'separate',
              borderLeft: '1px solid #4086c6',
              borderRight: '1px solid #4086c6',
              borderBottom: '1px solid #4086c6',
              borderRadius: '0 0 15px 15px',
            }}
          >
            <Row>
              <Column style={{ width: '50%', textAlign: 'center', padding: '5px' }}>
                <Button href={poll_option_1_link} style={POLL_BUTTON}>
                  {poll_option_1_label}
                </Button>
              </Column>
              <Column style={{ width: '50%', textAlign: 'center', padding: '5px' }}>
                {poll_option_2_label ? (
                  <Button href={poll_option_2_link} style={POLL_BUTTON}>
                    {poll_option_2_label}
                  </Button>
                ) : null}
              </Column>
            </Row>
          </Section>
        ) : null}
      </>
    );
  },
};
