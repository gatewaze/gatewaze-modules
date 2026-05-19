/**
 * TaskDrawer — task detail panel (spec §7.6).
 * Uses the shared `SideDrawer` chrome (animation, backdrop, Esc-close).
 */

import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import {
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  IconButton,
  Select,
  Separator,
  Spinner,
  Text,
  TextArea,
  TextField,
} from '@radix-ui/themes';
import { TrashIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { SideDrawer } from '@/components/shared/SideDrawer';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { getTask, patchTask, deleteTask, listActivity, postComment } from '../lib/api-client';
import { AssigneePicker } from '../components/AssigneePicker';
import { MentionInput } from '../components/MentionInput';
import type { Status, CustomFieldDef, Task, ActivityFeedItem, Uuid } from '../../lib/types';

interface Props {
  taskId: Uuid;
  statuses: Status[];
  customFields: CustomFieldDef[];
  onClose: () => void;
  onChanged: () => void;
}

export function TaskDrawer({ taskId, statuses, onClose, onChanged }: Props) {
  const [task, setTask] = useState<Task | null>(null);
  const [activity, setActivity] = useState<ActivityFeedItem[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([getTask(taskId), listActivity(taskId)])
      .then(([t, a]) => {
        setTask(t.data.task);
        setActivity(a.data.items);
      })
      .catch(e => toast.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [taskId]);

  async function update(patch: Record<string, unknown>) {
    if (!task) return;
    const before = task;
    setTask({ ...task, ...patch } as Task);
    try {
      await patchTask(task.id, patch);
      onChanged();
      listActivity(task.id).then(a => setActivity(a.data.items));
    } catch (e) {
      toast.error((e as Error).message);
      setTask(before);
    }
  }

  async function submitComment(e: FormEvent) {
    e.preventDefault();
    if (!task || !commentBody.trim()) return;
    try {
      await postComment(task.id, commentBody);
      setCommentBody('');
      listActivity(task.id).then(a => setActivity(a.data.items));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function handleConfirmDelete() {
    if (!task) return;
    setDeleting(true);
    try {
      await deleteTask(task.id);
      toast.success('Task deleted');
      onChanged();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
      setConfirmDeleteOpen(false);
    }
  }

  return (
    <>
      <SideDrawer
        open
        onClose={onClose}
        width={720}
        title={
          task && (
            <TextField.Root
              value={task.title}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTask({ ...task, title: e.target.value } as Task)}
              onBlur={(e) => update({ title: e.target.value })}
              size="3"
              variant="soft"
              style={{ width: '100%' }}
            />
          )
        }
      >
        <Box p="5">
          {loading && (
            <Flex justify="center" align="center" py="9">
              <Spinner size="3" />
            </Flex>
          )}
          {!loading && task && (
            <>
              <Flex justify="end" mb="3">
                <IconButton variant="ghost" color="red" onClick={() => setConfirmDeleteOpen(true)} title="Delete">
                  <TrashIcon width="16" height="16" />
                </IconButton>
              </Flex>

              <Flex direction="column" gap="3" pb="4" style={{ borderBottom: '1px solid var(--gray-a5)' }}>
                <Field label="Status">
                  <Select.Root
                    value={task.status_id ?? ''}
                    onValueChange={(v) => update({ status_id: v || null })}
                  >
                    <Select.Trigger style={{ flex: 1 }} />
                    <Select.Content>
                      {statuses.map(s => (
                        <Select.Item key={s.id} value={s.id}>{s.name}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Field>
                <Field label="Assignee">
                  <Box style={{ flex: 1 }}>
                    <AssigneePicker
                      value={task.assignee_id}
                      onChange={(id) => update({ assignee_id: id })}
                      fullWidth
                    />
                  </Box>
                </Field>
                <Field label="Priority">
                  <Select.Root
                    value={task.priority ?? 'none'}
                    onValueChange={(v) => update({ priority: v === 'none' ? null : v })}
                  >
                    <Select.Trigger style={{ flex: 1 }} />
                    <Select.Content>
                      {['none', 'low', 'medium', 'high', 'urgent'].map(p => (
                        <Select.Item key={p} value={p}>{p}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </Field>
                <Field label="Start">
                  <TextField.Root
                    type="date"
                    value={task.start_date ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update({ start_date: e.target.value || null })}
                    style={{ flex: 1 }}
                  />
                </Field>
                <Field label="Due">
                  <TextField.Root
                    type="date"
                    value={task.due_date ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update({ due_date: e.target.value || null })}
                    style={{ flex: 1 }}
                  />
                </Field>
                <Field label="Estimate">
                  <TextField.Root
                    type="number"
                    step="0.25"
                    value={task.estimate_hours ?? ''}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update({ estimate_hours: e.target.value ? parseFloat(e.target.value) : null })}
                    placeholder="hours"
                    style={{ flex: 1 }}
                  />
                </Field>
              </Flex>

              <Box py="4" style={{ borderBottom: '1px solid var(--gray-a5)' }}>
                <Text as="div" size="2" weight="medium" mb="1">Description</Text>
                <TextArea
                  value={task.description ?? ''}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTask({ ...task, description: e.target.value } as Task)}
                  onBlur={(e) => update({ description: e.target.value })}
                  rows={6}
                  placeholder="Markdown supported"
                />
              </Box>

              <Box py="4">
                <Heading size="3" mb="2">Activity</Heading>
                <form onSubmit={submitComment}>
                  <MentionInput
                    value={commentBody}
                    onChange={setCommentBody}
                    placeholder="Add a comment… use @ to mention"
                    rows={2}
                  />
                  <Flex justify="end" mt="2">
                    <Button type="submit" disabled={!commentBody.trim()}>Comment</Button>
                  </Flex>
                </form>
                <Separator size="4" my="3" />
                <Flex direction="column" gap="2">
                  {activity.length === 0 && (
                    <Text size="2" color="gray">No activity yet.</Text>
                  )}
                  {activity.map(item => (
                    <ActivityItem
                      key={item.kind === 'comment' ? item.comment.id : item.activity.id}
                      item={item}
                    />
                  ))}
                </Flex>
              </Box>
            </>
          )}
        </Box>
      </SideDrawer>

      <ConfirmModal
        isOpen={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={handleConfirmDelete}
        title="Delete this task?"
        message="The task will be soft-deleted. You can restore it from the board settings later."
        confirmText={deleting ? 'Deleting…' : 'Delete task'}
        confirmColor="red"
        isProcessing={deleting}
      />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="3">
      <Text size="2" color="gray" style={{ width: 80, flexShrink: 0 }}>{label}</Text>
      {children}
    </Flex>
  );
}

function ActivityItem({ item }: { item: ActivityFeedItem }) {
  if (item.kind === 'comment') {
    return (
      <Box pl="3" style={{ borderLeft: '2px solid var(--accent-a6)', padding: '4px 0 4px 12px' }}>
        <Text size="1" color="gray">{new Date(item.comment.created_at).toLocaleString()}</Text>
        <Text as="div" size="2" style={{ whiteSpace: 'pre-wrap' }}>{renderCommentBody(item.comment.body)}</Text>
      </Box>
    );
  }
  const a = item.activity;
  return (
    <Flex align="center" gap="2">
      <Badge variant="soft" color="gray" size="1">{a.event_type}</Badge>
      <Text size="1" color="gray">
        {new Date(a.occurred_at).toLocaleString()} — {friendly(a.event_type, a.payload)}
      </Text>
    </Flex>
  );
}

function renderCommentBody(body: string): React.ReactNode[] {
  const re = /@\[([^\]]+)\]\(user:([0-9a-f-]{36})\)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body))) {
    if (m.index > lastIndex) nodes.push(body.slice(lastIndex, m.index));
    nodes.push(
      <Badge key={`m-${key++}`} variant="soft" color="blue" size="1">@{m[1]}</Badge>
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < body.length) nodes.push(body.slice(lastIndex));
  return nodes;
}

function friendly(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case 'created': return 'Task created';
    case 'title_changed': return `Title → "${payload.to}"`;
    case 'description_changed':
      return `Description updated (${payload.from_length ?? 0} → ${payload.to_length ?? 0} chars)`;
    case 'status_changed': return 'Status changed';
    case 'assignee_changed': return 'Assignee changed';
    case 'priority_changed': return `Priority → ${payload.to ?? '—'}`;
    case 'estimate_changed': return `Estimate → ${payload.to ?? '—'}h`;
    case 'start_date_changed': return `Start → ${payload.to ?? '—'}`;
    case 'due_date_changed': return `Due → ${payload.to ?? '—'}`;
    case 'parent_changed': return 'Parent changed';
    case 'dependency_added': return 'Dependency added';
    case 'dependency_removed': return 'Dependency removed';
    case 'link_added': return `Linked to ${payload.entity_type ?? ''}`;
    case 'link_removed': return 'Link removed';
    case 'comment_added': return 'Commented';
    case 'auto_completed_parent': return 'Auto-completed (children done)';
    case 'recurrence_spawned': return 'Recurring instance spawned';
    case 'reordered': return 'Reordered';
    case 'soft_deleted': return 'Deleted';
    case 'restored': return 'Restored';
    default: return eventType;
  }
}
