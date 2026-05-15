/**
 * Avatar paired with name + role. Compact identity block for bylines
 * and contributor mentions.
 */

import { Column, Img, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface AvatarWithNameProps extends Record<string, unknown> {
  src: string;
  name: string;
  role: string;
}

export const AvatarWithNameBlock: EmailBlockEntry<AvatarWithNameProps> = {
  componentId: 'avatar_with_name',
  label: 'Avatar with name',
  category: 'Avatars',
  fields: {
    src: { type: 'custom', label: 'Avatar', render: NewsletterImageFieldAdapter as never },
    name: { type: 'text', label: 'Name' },
    role: { type: 'text', label: 'Role / company' },
  },
  defaultProps: { src: '', name: 'Jane Doe', role: 'Engineering Manager' },
  Component: ({ src, name, role }) => (
    <Section style={{ padding: '12px 0' }}>
      <Row>
        {src ? (
          <Column style={{ width: 56, verticalAlign: 'middle' }}>
            <Img src={src} alt="" width={48} height={48} style={{ borderRadius: 24 }} />
          </Column>
        ) : null}
        <Column style={{ verticalAlign: 'middle', paddingLeft: src ? 12 : 0 }}>
          <Text style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>{name}</Text>
          <Text style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>{role}</Text>
        </Column>
      </Row>
    </Section>
  ),
};
