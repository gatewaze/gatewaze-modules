/**
 * Bullet List composite — 2x2 grid of bulleted text. Mirrors the
 * "Getting started" section in Barebone `welcome.tsx`: four short
 * onboarding bullets laid out as two rows of two.
 *
 * Each bullet is a small ringed circle (the bullet glyph) above a
 * couple of sentences. Renders to `<table>` rows so it survives
 * Outlook / Gmail / Apple Mail.
 */

import { Column, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

interface BulletListProps extends Record<string, unknown> {
  bullet_1: string;
  bullet_2: string;
  bullet_3: string;
  bullet_4: string;
}

const BULLET_GLYPH = (
  <Text style={{ margin: 0, marginBottom: 16 }}>
    <span
      style={{
        display: 'inline-block',
        width: 24,
        height: 24,
        borderRadius: 12,
        border: '1px solid #E4E4E7',
        verticalAlign: 'middle',
      }}
    />
  </Text>
);

function Cell({ body }: { body: string }) {
  return (
    <>
      {BULLET_GLYPH}
      <Text style={{ margin: 0, fontSize: 16, color: '#43454B', lineHeight: 1.6 }}>{body}</Text>
    </>
  );
}

export const BulletListBlock: EmailBlockEntry<BulletListProps> = {
  componentId: 'bullet_list',
  label: 'Bullet list (2x2)',
  category: 'Content',
  fields: {
    bullet_1: { type: 'textarea', label: 'Bullet 1' },
    bullet_2: { type: 'textarea', label: 'Bullet 2' },
    bullet_3: { type: 'textarea', label: 'Bullet 3' },
    bullet_4: { type: 'textarea', label: 'Bullet 4' },
  },
  defaultProps: {
    bullet_1: 'Bring your team, tools, and workflows together in one place.',
    bullet_2: 'Permissions that match how you work.',
    bullet_3: 'Connect your stack and keep updates flowing.',
    bullet_4: 'Roles, guests, and access levels without admin overhead.',
  },
  Component: ({ bullet_1, bullet_2, bullet_3, bullet_4 }) => (
    <Section style={{ padding: '32px' }}>
      <Row style={{ marginBottom: 32 }}>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingRight: 32 }}>
          <Cell body={bullet_1} />
        </Column>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingRight: 32 }}>
          <Cell body={bullet_2} />
        </Column>
      </Row>
      <Row>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingRight: 32 }}>
          <Cell body={bullet_3} />
        </Column>
        <Column style={{ width: '50%', verticalAlign: 'top', paddingRight: 32 }}>
          <Cell body={bullet_4} />
        </Column>
      </Row>
    </Section>
  ),
};
