/**
 * KanbanView — status columns (spec §7.4).
 * Drag a card between columns to change status. "+ Add task" opens
 * the parent's NewTaskDrawer via the `onAddTask(statusId)` callback —
 * no browser prompts.
 */

import { useMemo, useState } from 'react';
import { Badge, Box, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { toast } from 'sonner';
import { patchTask } from '../lib/api-client';
import type { Status, Task, Uuid } from '../../lib/types';

interface Props {
  tasks: Task[];
  statuses: Status[];
  boardId: Uuid;
  onTaskOpen: (id: Uuid) => void;
  onTasksChanged: () => void;
  /**
   * Open the New Task drawer with `statusId` pre-selected. Provided
   * by `BoardDetailPage`; the column's "+ Add task" button calls it.
   */
  onAddTask: (statusId: Uuid) => void;
}

export function KanbanView({ tasks, statuses, onTaskOpen, onTasksChanged, onAddTask }: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const byStatus = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const s of statuses) m.set(s.id, []);
    for (const t of tasks) {
      if (t.status_id && m.has(t.status_id)) m.get(t.status_id)!.push(t);
    }
    return m;
  }, [tasks, statuses]);

  async function onDrop(statusId: string) {
    if (!draggingId) return;
    setDraggingId(null);
    try {
      await patchTask(draggingId, { status_id: statusId });
      onTasksChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Flex gap="3" p="3" style={{ overflowX: 'auto', height: '100%' }}>
      {statuses.map(status => {
        const cards = byStatus.get(status.id) ?? [];
        return (
          <Box
            key={status.id}
            onDragOver={e => e.preventDefault()}
            onDrop={() => onDrop(status.id)}
            style={{
              minWidth: 280,
              width: 280,
              backgroundColor: 'var(--gray-a3)',
              borderRadius: 'var(--radius-3)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Flex justify="between" align="center" px="3" py="2">
              <Flex align="center" gap="2">
                <Box
                  style={{
                    width: 8, height: 8, borderRadius: 4,
                    backgroundColor: status.color ?? 'var(--gray-9)',
                  }}
                />
                <Heading size="2">{status.name}</Heading>
                <Text size="1" color="gray">({cards.length})</Text>
              </Flex>
            </Flex>
            <Flex direction="column" gap="2" px="2" pb="2" style={{ flex: 1, overflowY: 'auto' }}>
              {cards.map(card => (
                <KanbanCard
                  key={card.id}
                  task={card}
                  onOpen={() => onTaskOpen(card.id)}
                  onDragStart={() => setDraggingId(card.id)}
                  onDragEnd={() => setDraggingId(null)}
                  dragging={draggingId === card.id}
                />
              ))}
              <Box
                onClick={() => onAddTask(status.id)}
                style={{
                  padding: '6px 10px',
                  fontSize: 12,
                  color: 'var(--gray-11)',
                  cursor: 'pointer',
                  borderRadius: 'var(--radius-2)',
                  userSelect: 'none',
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--gray-a4)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                + Add task
              </Box>
            </Flex>
          </Box>
        );
      })}
    </Flex>
  );
}

function KanbanCard({
  task, onOpen, onDragStart, onDragEnd, dragging,
}: {
  task: Task;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  return (
    <Card
      asChild
      variant="surface"
      style={{ cursor: 'grab', opacity: dragging ? 0.4 : 1 }}
    >
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
      >
        <Text size="2" weight="medium">{task.title}</Text>
        <Flex justify="between" align="center" mt="2">
          {task.priority && task.priority !== 'none' ? (
            <Badge color={priorityColor(task.priority)} variant="soft" size="1">
              {task.priority}
            </Badge>
          ) : <Box />}
          {task.due_date && <Text size="1" color="gray">{task.due_date}</Text>}
        </Flex>
      </div>
    </Card>
  );
}

function priorityColor(p: string): 'gray' | 'blue' | 'amber' | 'orange' | 'red' {
  switch (p) {
    case 'urgent': return 'red';
    case 'high': return 'orange';
    case 'medium': return 'amber';
    case 'low': return 'blue';
    default: return 'gray';
  }
}
