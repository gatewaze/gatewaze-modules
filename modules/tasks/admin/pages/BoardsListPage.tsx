/**
 * BoardsListPage — list of task boards (spec §7.1).
 *
 * Styled with Radix Theme primitives (matches the rest of the admin app).
 */

import { useEffect, useState, type FormEvent, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  Box,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Grid,
  Heading,
  Text,
  TextArea,
  TextField,
  Spinner,
} from '@radix-ui/themes';
import { PlusIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Page } from '@/components/shared/Page';
import { listBoards, createBoard } from '../lib/api-client';
import type { BoardSummary } from '../../lib/types';

export default function BoardsListPage() {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    listBoards()
      .then(r => setBoards(r.data))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Page title="Tasks">
      <Box p="6">
        <Flex justify="between" align="center" mb="5">
          <Box>
            <Heading size="6">Tasks</Heading>
            <Text size="2" color="gray">
              Asana-style boards with tree, kanban, and calendar views.
            </Text>
          </Box>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon width="16" height="16" />
            New board
          </Button>
        </Flex>

        {loading && (
          <Flex justify="center" align="center" py="9">
            <Spinner size="3" />
          </Flex>
        )}

        {error && !loading && (
          <Callout.Root color="red" mb="4">
            <Callout.Icon>
              <ExclamationTriangleIcon width="16" height="16" />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        {!loading && !error && boards.length === 0 && (
          <Card variant="surface">
            <Flex direction="column" align="center" gap="3" py="7">
              <Text size="3" color="gray">No boards yet.</Text>
              <Button onClick={() => setCreateOpen(true)}>
                <PlusIcon width="16" height="16" />
                Create your first board
              </Button>
            </Flex>
          </Card>
        )}

        <Grid columns={{ initial: '1', sm: '2', lg: '3' }} gap="3">
          {boards.map(b => <BoardCard key={b.id} board={b} />)}
        </Grid>

        <CreateBoardDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(board) => setBoards(prev => [board, ...prev])}
        />
      </Box>
    </Page>
  );
}

function BoardCard({ board }: { board: BoardSummary }) {
  const navigate = useNavigate();
  return (
    <Card
      variant="surface"
      onClick={() => navigate(`/admin/tasks/boards/${board.id}`)}
      style={{ cursor: 'pointer' }}
    >
      <Flex direction="column" gap="2">
        <Box
          style={{
            height: 4,
            borderRadius: 2,
            backgroundColor: board.color ?? 'var(--accent-9)',
          }}
        />
        <Heading size="3">{board.name}</Heading>
        {board.description && (
          <Text size="2" color="gray" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {board.description}
          </Text>
        )}
        <Text size="1" color="gray" mt="1">/{board.slug}</Text>
      </Flex>
    </Card>
  );
}

function CreateBoardDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (b: BoardSummary) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Slug validation is server-side (the migration's CHECK enforces
  // `^[a-z0-9-]+$`). The HTML `pattern` attribute is intentionally
  // omitted because Chrome compiles it with the `/v` flag, under
  // which the literal `-` in a character class is parsed strictly
  // and several escape variants (`\-`, `[-...]`, `[...-]`) trigger
  // "Invalid character class". Letting the input auto-format on
  // typing + server-side validation is simpler and avoids the
  // browser-compat trap entirely.
  function autoSlug(v: string) {
    const next = v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    setSlug(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const r = await createBoard({ name, slug, description } as Partial<BoardSummary>);
      onCreated(r.data.board);
      setName(''); setSlug(''); setDescription('');
      onOpenChange(false);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>New board</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          A board groups tasks with its own statuses, fields, and members.
        </Dialog.Description>
        <form onSubmit={submit}>
          <Flex direction="column" gap="3">
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Name</Text>
              <TextField.Root
                value={name}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setName(e.target.value);
                  if (!slug) autoSlug(e.target.value);
                }}
                placeholder="Marketing"
                required
              />
            </label>
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Slug</Text>
              <TextField.Root
                value={slug}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSlug(e.target.value)}
                placeholder="marketing"
                required
              />
              <Text size="1" color="gray">Lowercase letters, digits, and hyphens.</Text>
            </label>
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Description (optional)</Text>
              <TextArea
                value={description}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
                rows={3}
              />
            </label>
            {err && (
              <Callout.Root color="red">
                <Callout.Text>{err}</Callout.Text>
              </Callout.Root>
            )}
          </Flex>
          <Flex justify="end" gap="2" mt="4">
            <Dialog.Close>
              <Button variant="soft" color="gray" type="button">Cancel</Button>
            </Dialog.Close>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner />}
              {saving ? 'Creating…' : 'Create board'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
