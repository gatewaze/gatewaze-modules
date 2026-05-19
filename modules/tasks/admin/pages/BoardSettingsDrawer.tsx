/**
 * BoardSettingsDrawer — board configuration as a SideDrawer overlay
 * (spec §7.7). Renders inside the board detail page; no separate route.
 *
 * Uses inline forms and toast notifications — no browser prompts/alerts.
 */

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Select,
  Separator,
  Spinner,
  Switch,
  Text,
  TextArea,
  TextField,
} from '@radix-ui/themes';
import { ExclamationTriangleIcon, TrashIcon, PlusIcon, Bars3Icon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { SideDrawer } from '@/components/shared/SideDrawer';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { getBoard, patchBoard, createStatus, deleteStatus, patchStatus } from '../lib/api-client';
import type { BoardSummary, Status, Uuid } from '../../lib/types';

interface Props {
  boardId: Uuid;
  open: boolean;
  onClose: () => void;
  /** Fired after a settings change so the host can refresh metadata. */
  onChanged?: () => void;
}

export default function BoardSettingsDrawer({ boardId, open, onClose, onChanged }: Props) {
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmStatus, setConfirmStatus] = useState<Status | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [dragStatusId, setDragStatusId] = useState<Uuid | null>(null);
  const [dropTargetId, setDropTargetId] = useState<Uuid | null>(null);

  useEffect(() => {
    if (!open || !boardId) return;
    setLoading(true);
    getBoard(boardId)
      .then(r => {
        setBoard(r.data.board);
        setStatuses(r.data.statuses);
        setError(null);
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [open, boardId]);

  async function update(patch: Partial<BoardSummary>) {
    if (!board) return;
    const before = board;
    setBoard({ ...board, ...patch });
    try {
      await patchBoard(board.id, patch);
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
      setBoard(before);
    }
  }

  async function handleAddStatus(name: string, color: string | null) {
    if (!name.trim()) return;
    try {
      const r = await createStatus(boardId, {
        name: name.trim(),
        color,
        sort_index: statuses.length,
      });
      setStatuses(prev => [...prev, r.data]);
      toast.success('Status added');
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function reorderStatuses(srcId: Uuid, targetId: Uuid) {
    if (srcId === targetId) return;
    const srcIdx = statuses.findIndex(s => s.id === srcId);
    const targetIdx = statuses.findIndex(s => s.id === targetId);
    if (srcIdx === -1 || targetIdx === -1) return;
    const next = statuses.slice();
    const [moved] = next.splice(srcIdx, 1);
    next.splice(targetIdx, 0, moved!);
    // Optimistic: assign fresh sort_indexes by position.
    const reindexed = next.map((s, i) => ({ ...s, sort_index: i }));
    const before = statuses;
    setStatuses(reindexed);
    // Persist only the rows whose sort_index actually changed.
    const changes = reindexed.filter((s, i) => before.find(b => b.id === s.id)?.sort_index !== i);
    try {
      await Promise.all(changes.map(s => patchStatus(boardId, s.id, { sort_index: s.sort_index })));
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
      setStatuses(before);
    }
  }

  async function handleDeleteStatus() {
    if (!confirmStatus) return;
    try {
      await deleteStatus(boardId, confirmStatus.id);
      setStatuses(prev => prev.filter(s => s.id !== confirmStatus.id));
      toast.success('Status removed');
      onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConfirmStatus(null);
    }
  }

  return (
    <>
      <SideDrawer
        open={open}
        onClose={onClose}
        width={640}
        title="Board settings"
        subtitle={board?.name}
      >
        <Box p="5">
          {loading && (
            <Flex justify="center" align="center" py="9">
              <Spinner size="3" />
            </Flex>
          )}

          {error && !loading && (
            <Callout.Root color="red">
              <Callout.Icon><ExclamationTriangleIcon width="16" height="16" /></Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          {!loading && board && (
            <Flex direction="column" gap="6">
              <Section title="General">
                <Field label="Name">
                  <TextField.Root
                    value={board.name}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setBoard({ ...board, name: e.target.value })}
                    onBlur={(e) => update({ name: e.target.value })}
                  />
                </Field>
                <Field label="Description">
                  <TextArea
                    value={board.description ?? ''}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setBoard({ ...board, description: e.target.value })}
                    onBlur={(e) => update({ description: e.target.value })}
                    rows={2}
                  />
                </Field>
                <Field label="Color">
                  <input
                    type="color"
                    value={board.color ?? '#94A3B8'}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => update({ color: e.target.value })}
                    style={{
                      width: 60,
                      height: 32,
                      border: '1px solid var(--gray-a6)',
                      borderRadius: 'var(--radius-2)',
                      background: 'transparent',
                    }}
                  />
                </Field>
              </Section>

              <Section title="Workflow">
                <Field label="Dependency mode">
                  <Select.Root
                    value={board.dependency_mode}
                    onValueChange={(v) => update({ dependency_mode: v as 'hard' | 'soft' })}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="soft">Soft — visual warning only</Select.Item>
                      <Select.Item value="hard">Hard — blocks status flip</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </Field>
                <Field label="Parent completion">
                  <Select.Root
                    value={board.parent_completion}
                    onValueChange={(v) => update({ parent_completion: v as 'auto' | 'manual' })}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="manual">Manual — each task independent</Select.Item>
                      <Select.Item value="auto">Auto — parent done when all children done</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </Field>
                <Field label="Kanban shows">
                  <Select.Root
                    value={board.kanban_includes}
                    onValueChange={(v) => update({ kanban_includes: v as 'top_only' | 'all' })}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="top_only">Top-level tasks only</Select.Item>
                      <Select.Item value="all">All tasks (including subtasks)</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </Field>
                <Field label="Real-time updates">
                  <Flex align="center" gap="3">
                    <Switch
                      checked={board.realtime_enabled}
                      onCheckedChange={(v) => update({ realtime_enabled: v })}
                    />
                    <Text size="2" color="gray">
                      Live updates when other users edit. Disable for very large boards.
                    </Text>
                  </Flex>
                </Field>
              </Section>

              <Section title="Statuses">
                <Text size="1" color="gray" mb="1">Drag to reorder.</Text>
                <Flex direction="column" gap="2">
                  {statuses.map(s => {
                    const isDragging = dragStatusId === s.id;
                    const isDropTarget = dropTargetId === s.id && dragStatusId !== s.id;
                    return (
                      <Card
                        key={s.id}
                        variant="surface"
                        onDragOver={(e) => {
                          if (!dragStatusId || dragStatusId === s.id) return;
                          e.preventDefault();
                          if (dropTargetId !== s.id) setDropTargetId(s.id);
                        }}
                        onDragLeave={() => {
                          if (dropTargetId === s.id) setDropTargetId(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragStatusId && dragStatusId !== s.id) {
                            void reorderStatuses(dragStatusId, s.id);
                          }
                          setDragStatusId(null);
                          setDropTargetId(null);
                        }}
                        style={{
                          opacity: isDragging ? 0.4 : 1,
                          outline: isDropTarget ? '2px solid var(--accent-9)' : undefined,
                          outlineOffset: isDropTarget ? -2 : undefined,
                        }}
                      >
                        <Flex justify="between" align="center">
                          <Flex align="center" gap="2" style={{ minWidth: 0, flex: 1 }}>
                            <Box
                              draggable
                              onDragStart={(e) => {
                                setDragStatusId(s.id);
                                e.dataTransfer.effectAllowed = 'move';
                              }}
                              onDragEnd={() => {
                                setDragStatusId(null);
                                setDropTargetId(null);
                              }}
                              title="Drag to reorder"
                              style={{
                                cursor: 'grab',
                                color: 'var(--gray-9)',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '2px 4px',
                              }}
                            >
                              <Bars3Icon width="16" height="16" />
                            </Box>
                            <Box style={{
                              width: 10, height: 10, borderRadius: 5,
                              backgroundColor: s.color ?? 'var(--gray-9)',
                            }} />
                            <Text size="2" weight="medium">{s.name}</Text>
                            {s.is_done_state && <Badge color="green" variant="soft" size="1">done</Badge>}
                            {s.is_default && <Badge color="blue" variant="soft" size="1">default</Badge>}
                          </Flex>
                          <Button variant="ghost" color="red" size="1" onClick={() => setConfirmStatus(s)}>
                            <TrashIcon width="14" height="14" />
                            Remove
                          </Button>
                        </Flex>
                      </Card>
                    );
                  })}
                </Flex>
                <AddStatusForm onAdd={handleAddStatus} />
              </Section>

              <Separator size="4" />

              <Section title="Danger zone">
                <Button
                  color="red"
                  variant="soft"
                  onClick={() => setConfirmArchive(true)}
                >
                  {board.archived ? 'Unarchive board' : 'Archive board'}
                </Button>
              </Section>
            </Flex>
          )}
        </Box>
      </SideDrawer>

      <ConfirmModal
        isOpen={!!confirmStatus}
        onClose={() => setConfirmStatus(null)}
        onConfirm={handleDeleteStatus}
        title="Remove this status?"
        message={
          confirmStatus
            ? `Tasks currently set to "${confirmStatus.name}" must be reassigned first; otherwise the API will reject the delete.`
            : ''
        }
        confirmText="Remove status"
        confirmColor="red"
      />

      <ConfirmModal
        isOpen={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => {
          if (board) update({ archived: !board.archived });
          setConfirmArchive(false);
        }}
        title={board?.archived ? 'Unarchive board?' : 'Archive board?'}
        message={
          board?.archived
            ? 'The board will be visible in the main list again.'
            : 'Archived boards are hidden from the main list. You can unarchive any time.'
        }
        confirmText={board?.archived ? 'Unarchive' : 'Archive'}
        confirmColor={board?.archived ? 'blue' : 'red'}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Heading size="3" mb="3">{title}</Heading>
      <Flex direction="column" gap="3">{children}</Flex>
    </Box>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text as="div" size="2" weight="medium" mb="1" color="gray">{label}</Text>
      {children}
    </Box>
  );
}

function AddStatusForm({ onAdd }: { onAdd: (name: string, color: string | null) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#94A3B8');
  const [adding, setAdding] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    await onAdd(name, color);
    setAdding(false);
    setName('');
    setExpanded(false);
  }

  if (!expanded) {
    return (
      <Button variant="soft" mt="2" onClick={() => setExpanded(true)}>
        <PlusIcon width="14" height="14" />
        Add status
      </Button>
    );
  }

  return (
    <Card variant="surface" mt="2">
      <form onSubmit={submit}>
        <Flex gap="2" align="end">
          <Box style={{ flex: 1 }}>
            <Text as="div" size="1" color="gray" mb="1">Name</Text>
            <TextField.Root
              autoFocus
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              placeholder="In review"
              required
            />
          </Box>
          <Box>
            <Text as="div" size="1" color="gray" mb="1">Color</Text>
            <input
              type="color"
              value={color}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setColor(e.target.value)}
              style={{
                width: 40, height: 32,
                border: '1px solid var(--gray-a6)',
                borderRadius: 'var(--radius-2)',
                background: 'transparent',
              }}
            />
          </Box>
          <Button type="submit" disabled={adding || !name.trim()}>
            {adding && <Spinner />}
            {adding ? 'Adding…' : 'Add'}
          </Button>
          <Button type="button" variant="soft" color="gray" onClick={() => { setExpanded(false); setName(''); }}>
            Cancel
          </Button>
        </Flex>
      </form>
    </Card>
  );
}
