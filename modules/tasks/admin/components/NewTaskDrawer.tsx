/**
 * NewTaskDrawer — create-task form rendered in the canonical
 * `SideDrawer` (matches EventHosts, Inbox, etc. — slide-in animation,
 * shared chrome, Esc-to-close).
 *
 * Replaces the prior `window.prompt('Task title?')` flow. Accepts an
 * optional `defaultStatusId` so the Kanban view can pre-select the
 * column the user clicked "+ Add" on.
 */

import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import {
  Box,
  Button,
  Callout,
  Flex,
  Select,
  Spinner,
  Text,
  TextArea,
  TextField,
} from '@radix-ui/themes';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { SideDrawer } from '@/components/shared/SideDrawer';
import { createTask } from '../lib/api-client';
import { AssigneePicker } from './AssigneePicker';
import type { Status, Task, Uuid } from '../../lib/types';

interface Props {
  boardId: Uuid;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  statuses: Status[];
  defaultStatusId?: Uuid | null;
  defaultParentId?: Uuid | null;
  /** Called after a task is created so the host can refresh. */
  onCreated?: (task: Task) => void;
}

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export function NewTaskDrawer({
  boardId,
  open,
  onOpenChange,
  statuses,
  defaultStatusId = null,
  defaultParentId = null,
  onCreated,
}: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [statusId, setStatusId] = useState<string>('');
  const [assigneeId, setAssigneeId] = useState<Uuid | null>(null);
  const [priority, setPriority] = useState<string>('none');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [estimate, setEstimate] = useState('');
  const [recurrenceRule, setRecurrenceRule] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    const defaultStatus =
      defaultStatusId ??
      statuses.find(s => s.is_default)?.id ??
      statuses[0]?.id ??
      '';
    setStatusId(defaultStatus);
    setAssigneeId(null);
    setPriority('none');
    setStartDate('');
    setDueDate('');
    setEstimate('');
    setRecurrenceRule('');
    setShowAdvanced(false);
    setError(null);
  }, [open, defaultStatusId, statuses]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await createTask(boardId, {
        title: title.trim(),
        description: description || null,
        status_id: statusId || null,
        assignee_id: assigneeId,
        priority: priority === 'none' ? null : priority,
        start_date: startDate || null,
        due_date: dueDate || null,
        estimate_hours: estimate ? parseFloat(estimate) : null,
        recurrence_rule: recurrenceRule || null,
        parent_task_id: defaultParentId,
      });
      toast.success('Task created');
      onCreated?.(r.data.task);
      onOpenChange(false);
    } catch (e2) {
      setError((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SideDrawer
      open={open}
      onClose={() => onOpenChange(false)}
      title="New task"
      width={560}
    >
      <Box p="5" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box style={{ flex: 1, overflow: 'auto' }}>
          <form id="new-task-form" onSubmit={submit}>
            <Flex direction="column" gap="3">
              <label>
                <Text as="div" size="2" weight="medium" mb="1">Title</Text>
                <TextField.Root
                  autoFocus
                  value={title}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
                  placeholder="What needs doing?"
                  required
                />
              </label>

              <label>
                <Text as="div" size="2" weight="medium" mb="1">Description</Text>
                <TextArea
                  value={description}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                  placeholder="Markdown supported. Optional."
                  rows={4}
                />
              </label>

              <Flex gap="3">
                <Box style={{ flex: 1 }}>
                  <Text as="div" size="2" weight="medium" mb="1">Status</Text>
                  <Select.Root value={statusId} onValueChange={setStatusId}>
                    <Select.Trigger placeholder="—" style={{ width: '100%' }} />
                    <Select.Content>
                      {statuses.map(s => (
                        <Select.Item key={s.id} value={s.id}>{s.name}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Box>
                <Box style={{ flex: 1 }}>
                  <Text as="div" size="2" weight="medium" mb="1">Priority</Text>
                  <Select.Root value={priority} onValueChange={setPriority}>
                    <Select.Trigger style={{ width: '100%' }} />
                    <Select.Content>
                      {PRIORITIES.map(p => (
                        <Select.Item key={p} value={p}>{p}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Box>
              </Flex>

              <Box>
                <Text as="div" size="2" weight="medium" mb="1">Assignee</Text>
                <AssigneePicker value={assigneeId} onChange={setAssigneeId} fullWidth />
              </Box>

              <Flex gap="3">
                <Box style={{ flex: 1 }}>
                  <Text as="div" size="2" weight="medium" mb="1">Start date</Text>
                  <TextField.Root
                    type="date"
                    value={startDate}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setStartDate(e.target.value)}
                  />
                </Box>
                <Box style={{ flex: 1 }}>
                  <Text as="div" size="2" weight="medium" mb="1">Due date</Text>
                  <TextField.Root
                    type="date"
                    value={dueDate}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setDueDate(e.target.value)}
                  />
                </Box>
              </Flex>

              <Box>
                <Text as="div" size="2" weight="medium" mb="1">Estimate (hours)</Text>
                <TextField.Root
                  type="number"
                  step="0.25"
                  min="0"
                  value={estimate}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEstimate(e.target.value)}
                  placeholder="4"
                />
              </Box>

              <Box>
                <Button
                  type="button"
                  variant="ghost"
                  color="gray"
                  size="2"
                  onClick={() => setShowAdvanced(s => !s)}
                >
                  {showAdvanced ? '− Hide' : '+ Show'} advanced
                </Button>
              </Box>

              {showAdvanced && (
                <Box>
                  <Text as="div" size="2" weight="medium" mb="1">Recurrence (RRULE)</Text>
                  <TextField.Root
                    value={recurrenceRule}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setRecurrenceRule(e.target.value)}
                    placeholder="FREQ=WEEKLY;BYDAY=MO"
                  />
                  <Text size="1" color="gray">
                    RFC 5545 RRULE string. When set + completed, the next instance is auto-spawned. e.g. FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO,WE,FR.
                  </Text>
                </Box>
              )}

              {error && (
                <Callout.Root color="red">
                  <Callout.Icon><ExclamationTriangleIcon width="16" height="16" /></Callout.Icon>
                  <Callout.Text>{error}</Callout.Text>
                </Callout.Root>
              )}
            </Flex>
          </form>
        </Box>

        <Flex justify="end" gap="2" pt="3" mt="3" style={{ borderTop: '1px solid var(--gray-a5)' }}>
          <Button variant="soft" color="gray" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-task-form" disabled={saving || !title.trim()}>
            {saving && <Spinner />}
            {saving ? 'Creating…' : 'Create task'}
          </Button>
        </Flex>
      </Box>
    </SideDrawer>
  );
}
