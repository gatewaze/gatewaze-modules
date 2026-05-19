/**
 * TreeView — nested-list rendering with drag-and-drop (spec §7.3).
 * Styled with Radix Theme primitives.
 */

import { useMemo, useState } from 'react';
import { Badge, Box, Checkbox, Flex, IconButton, Text } from '@radix-ui/themes';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { reorderTask, reparentTask, patchTask } from '../lib/api-client';
import type { Status, CustomFieldDef, TreeTask, Uuid } from '../../lib/types';

interface Props {
  tasks: TreeTask[];
  statuses: Status[];
  customFields: CustomFieldDef[];
  onTaskOpen: (id: Uuid) => void;
  onTasksChanged: () => void;
}

export function TreeView({ tasks, statuses, onTaskOpen, onTasksChanged }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tasks.map(t => t.id)));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' | 'child' } | null>(null);

  const statusMap = useMemo(() => new Map(statuses.map(s => [s.id, s])), [statuses]);

  const visibleTasks = useMemo(() => {
    return tasks.filter(t => {
      let cur = t.parent_task_id;
      while (cur) {
        if (!expanded.has(cur)) return false;
        const parent = tasks.find(p => p.id === cur);
        cur = parent?.parent_task_id ?? null;
      }
      return true;
    });
  }, [tasks, expanded]);

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onDrop(target: TreeTask, pos: 'before' | 'after' | 'child') {
    if (!draggingId || draggingId === target.id) return;
    const dragged = tasks.find(t => t.id === draggingId);
    if (!dragged) return;
    setDropTarget(null);
    setDraggingId(null);
    try {
      if (pos === 'child') {
        await reparentTask(draggingId, { new_parent_id: target.id, after_task_id: null, before_task_id: null });
      } else {
        const siblings = tasks
          .filter(t => t.parent_task_id === target.parent_task_id)
          .sort((a, b) => (a.sort_index < b.sort_index ? -1 : 1));
        const idx = siblings.findIndex(s => s.id === target.id);
        const before = pos === 'before' ? siblings[idx - 1]?.id ?? null : target.id;
        const after = pos === 'before' ? target.id : siblings[idx + 1]?.id ?? null;
        if (dragged.parent_task_id === target.parent_task_id) {
          await reorderTask(draggingId, { after_task_id: before, before_task_id: after });
        } else {
          await reparentTask(draggingId, {
            new_parent_id: target.parent_task_id,
            after_task_id: before,
            before_task_id: after,
          });
        }
      }
      onTasksChanged();
    } catch (e) {
      toast.error(`Drop failed: ${(e as Error).message}`);
    }
  }

  async function toggleDone(task: TreeTask) {
    const doneStatus = statuses.find(s => s.is_done_state);
    if (!doneStatus) return;
    const newStatusId = task.is_done
      ? statuses.find(s => s.is_default)?.id ?? statuses[0]?.id
      : doneStatus.id;
    try {
      await patchTask(task.id, { status_id: newStatusId });
      onTasksChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (visibleTasks.length === 0) {
    return (
      <Flex justify="center" align="center" style={{ height: '100%' }}>
        <Text size="2" color="gray">No tasks yet — click "+ New task" to add one.</Text>
      </Flex>
    );
  }

  return (
    <Box style={{ overflow: 'auto', height: '100%' }}>
      <Box>
        {visibleTasks.map(task => {
          const hasChildren = tasks.some(t => t.parent_task_id === task.id);
          const isExpanded = expanded.has(task.id);
          const status = task.status_id ? statusMap.get(task.status_id) : null;
          const isTargeting = dropTarget?.id === task.id;
          return (
            <Box
              key={task.id}
              draggable
              onDragStart={() => setDraggingId(task.id)}
              onDragEnd={() => { setDraggingId(null); setDropTarget(null); }}
              onDragOver={e => {
                e.preventDefault();
                const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                const y = e.clientY - rect.top;
                const ratio = y / rect.height;
                const pos: 'before' | 'after' | 'child' =
                  ratio < 0.33 ? 'before' : ratio > 0.66 ? 'after' : 'child';
                setDropTarget({ id: task.id, pos });
              }}
              onDrop={() => dropTarget && onDrop(task, dropTarget.pos)}
              style={{
                paddingLeft: 12 + task.depth * 20,
                paddingRight: 12,
                opacity: draggingId === task.id ? 0.4 : 1,
                borderTop: isTargeting && dropTarget.pos === 'before' ? '2px solid var(--accent-9)' : '2px solid transparent',
                borderBottom: isTargeting && dropTarget.pos === 'after' ? '2px solid var(--accent-9)' : '2px solid transparent',
                backgroundColor: isTargeting && dropTarget.pos === 'child' ? 'var(--accent-a3)' : 'transparent',
                cursor: 'grab',
              }}
            >
              <Flex
                align="center"
                gap="2"
                py="2"
                className="tree-row"
                style={{ borderBottom: '1px solid var(--gray-a3)' }}
              >
                {hasChildren ? (
                  <IconButton
                    variant="ghost"
                    color="gray"
                    size="1"
                    onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                  >
                    {isExpanded ? <ChevronDownIcon width="14" height="14" /> : <ChevronRightIcon width="14" height="14" />}
                  </IconButton>
                ) : (
                  <Box width="24px" />
                )}
                <Checkbox
                  checked={task.is_done}
                  onCheckedChange={() => toggleDone(task)}
                  onClick={e => e.stopPropagation()}
                />
                <Text
                  size="2"
                  onClick={() => onTaskOpen(task.id)}
                  style={{
                    flex: 1,
                    cursor: 'pointer',
                    textDecoration: task.is_done ? 'line-through' : 'none',
                    color: task.is_done ? 'var(--gray-9)' : 'inherit',
                  }}
                >
                  {task.title}
                </Text>
                {status && (
                  <Badge
                    color={statusColor(status)}
                    variant="soft"
                    size="1"
                  >
                    {status.name}
                  </Badge>
                )}
                {task.due_date && (
                  <Text size="1" color="gray">{task.due_date}</Text>
                )}
              </Flex>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * Pick a Radix accent colour for a status. v1 maps by status name
 * (case-insensitive); v2 could honour `status.color` when set.
 */
function statusColor(status: Status): 'gray' | 'blue' | 'amber' | 'green' | 'red' {
  if (status.is_done_state) return 'green';
  const n = status.name.toLowerCase();
  if (n.includes('doing') || n.includes('progress') || n.includes('review')) return 'amber';
  if (n.includes('blocked') || n.includes('cancel')) return 'red';
  if (n.includes('todo') || n.includes('next')) return 'blue';
  return 'gray';
}
