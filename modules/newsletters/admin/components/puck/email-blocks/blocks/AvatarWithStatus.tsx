/**
 * Avatar with an inline status badge. Common in product update emails
 * announcing new hires, status changes, or activity notifications.
 */

import { Column, Img, Row, Section, Text } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface AvatarWithStatusProps extends Record<string, unknown> {
  src: string;
  name: string;
  status_label: string;
  status_color: string;
}

export const AvatarWithStatusBlock: EmailBlockEntry<AvatarWithStatusProps> = {
  componentId: 'avatar_with_status',
  label: 'Avatar with status badge',
  category: 'Avatars',
  fields: {
    src: { type: 'custom', label: 'Avatar', render: NewsletterImageFieldAdapter as never },
    name: { type: 'text', label: 'Name' },
    status_label: { type: 'text', label: 'Status label' },
    status_color: { type: 'text', label: 'Status colour' },
  },
  defaultProps: {
    src: '',
    name: 'Jane Doe',
    status_label: 'Online',
    status_color: '#10B981',
  },
  Component: ({ src, name, status_label, status_color }) => (
    <Section style={{ padding: '12px 0' }}>
      <Row>
        {src ? (
          <Column style={{ width: 56, verticalAlign: 'middle' }}>
            <Img src={src} alt="" width={48} height={48} style={{ borderRadius: 24 }} />
          </Column>
        ) : null}
        <Column style={{ verticalAlign: 'middle', paddingLeft: src ? 12 : 0 }}>
          <Text style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>{name}</Text>
          <Text style={{ margin: 0, fontSize: 12, color: status_color, fontWeight: 600 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, backgroundColor: status_color, marginRight: 6 }} />
            {status_label}
          </Text>
        </Column>
      </Row>
    </Section>
  ),
};
