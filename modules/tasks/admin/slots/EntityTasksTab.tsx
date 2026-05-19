/**
 * EntityTasksTab — bi-directional surface (spec §7.9).
 * Renders inside event/speaker/content/list detail pages as an admin slot.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Spinner,
  Text,
} from '@radix-ui/themes';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { tasksByEntity } from '../lib/api-client';
import type { Task, EntityType } from '../../lib/types';

interface Props {
  entityType: EntityType;
  entityId: string;
}

export default function EntityTasksTab({ entityType, entityId }: Props) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    tasksByEntity(entityType, entityId)
      .then(r => setTasks(r.data.tasks))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [entityType, entityId]);

  const label = entityType.replace(/_/g, ' ');

  return (
    <Box p="4">
      <Flex justify="between" align="center" mb="3">
        <Heading size="3">Tasks linked to this {label}</Heading>
      </Flex>

      {loading && <Spinner size="2" />}

      {error && !loading && (
        <Callout.Root color="red">
          <Callout.Icon><ExclamationTriangleIcon width="16" height="16" /></Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      {!loading && !error && tasks.length === 0 && (
        <Card variant="surface">
          <Flex justify="center" py="5">
            <Text size="2" color="gray">No tasks linked yet.</Text>
          </Flex>
        </Card>
      )}

      <Flex direction="column" gap="1">
        {tasks.map(t => (
          <Card key={t.id} variant="surface">
            <Flex justify="between" align="center">
              <Text
                size="2"
                style={{
                  textDecoration: t.is_done ? 'line-through' : 'none',
                  color: t.is_done ? 'var(--gray-9)' : 'inherit',
                }}
              >
                {t.title}
              </Text>
              <Button
                size="1"
                variant="soft"
                onClick={() => navigate(`/admin/tasks/boards/${t.board_id}?task=${t.id}`)}
              >
                Open
              </Button>
            </Flex>
          </Card>
        ))}
      </Flex>
    </Box>
  );
}
