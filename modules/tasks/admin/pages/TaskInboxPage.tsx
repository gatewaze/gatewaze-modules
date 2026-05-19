/**
 * TaskInboxPage — personal notifications (spec §7.8).
 * Styled with Radix Theme.
 */

import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Heading,
  Spinner,
  Switch,
  Text,
} from '@radix-ui/themes';
import {
  AtSymbolIcon,
  ChatBubbleLeftIcon,
  ClockIcon,
  ArrowPathIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { Page } from '@/components/shared/Page';
import { listNotifications, markRead } from '../lib/api-client';
import type { Notification } from '../../lib/types';

export default function TaskInboxPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listNotifications(unreadOnly)
      .then(r => setItems(r.data.items))
      .finally(() => setLoading(false));
  }, [unreadOnly]);

  async function markAll() {
    await markRead({ all: true });
    setItems(items.map(i => ({ ...i, read_at: new Date().toISOString() })));
  }

  async function markOne(id: string) {
    await markRead([id]);
    setItems(items.map(i => i.id === id ? { ...i, read_at: new Date().toISOString() } : i));
  }

  return (
    <Page title="Inbox">
      <Box p="6" style={{ maxWidth: 760, margin: '0 auto' }}>
        <Flex justify="between" align="center" mb="4">
          <Heading size="6">Inbox</Heading>
          <Flex gap="3" align="center">
            <Flex gap="2" align="center">
              <Switch
                checked={unreadOnly}
                onCheckedChange={setUnreadOnly}
                size="1"
              />
              <Text size="2">Unread only</Text>
            </Flex>
            <Button variant="soft" color="gray" onClick={markAll}>
              Mark all read
            </Button>
          </Flex>
        </Flex>

        {loading && (
          <Flex justify="center" py="7">
            <Spinner size="3" />
          </Flex>
        )}

        {!loading && items.length === 0 && (
          <Card variant="surface">
            <Flex direction="column" align="center" gap="2" py="6">
              <Text size="3" color="gray">Nothing here right now.</Text>
            </Flex>
          </Card>
        )}

        <Flex direction="column" gap="2">
          {items.map(n => (
            <Card key={n.id} variant="surface" style={{ opacity: n.read_at ? 0.6 : 1 }}>
              <Flex align="start" gap="3">
                <KindIcon kind={n.kind} />
                <Box style={{ flex: 1 }}>
                  <Text as="div" size="2">{friendlyKind(n.kind)}</Text>
                  <Text size="1" color="gray">{new Date(n.created_at).toLocaleString()}</Text>
                </Box>
                {!n.read_at && (
                  <Button size="1" variant="ghost" onClick={() => markOne(n.id)}>Mark read</Button>
                )}
              </Flex>
            </Card>
          ))}
        </Flex>
      </Box>
    </Page>
  );
}

function KindIcon({ kind }: { kind: Notification['kind'] }) {
  const props = { width: 18, height: 18 };
  const color: 'gray' | 'blue' | 'amber' | 'red' | 'green' = (() => {
    switch (kind) {
      case 'assigned': return 'blue';
      case 'mentioned': return 'amber';
      case 'comment_on_followed': return 'gray';
      case 'due_soon': return 'red';
      case 'status_changed_for_followed': return 'green';
    }
  })();
  const Icon = (() => {
    switch (kind) {
      case 'assigned': return UserCircleIcon;
      case 'mentioned': return AtSymbolIcon;
      case 'comment_on_followed': return ChatBubbleLeftIcon;
      case 'due_soon': return ClockIcon;
      case 'status_changed_for_followed': return ArrowPathIcon;
    }
  })();
  return (
    <Badge color={color} variant="soft" radius="full" style={{ padding: 6 }}>
      <Icon {...props} />
    </Badge>
  );
}

function friendlyKind(kind: Notification['kind']): string {
  switch (kind) {
    case 'assigned': return 'You were assigned a task';
    case 'mentioned': return 'You were mentioned';
    case 'comment_on_followed': return 'New comment on a task you follow';
    case 'due_soon': return 'Task due soon';
    case 'status_changed_for_followed': return 'Task status changed';
  }
}
