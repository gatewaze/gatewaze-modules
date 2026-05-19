/**
 * BoardDetailPage — view switcher + filter bar + drawer (spec §7.2).
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import {
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  Tabs,
  TextField,
  Spinner,
} from '@radix-ui/themes';
import { PlusIcon, Cog6ToothIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Page } from '@/components/shared/Page';
import { getBoard, listTasks } from '../lib/api-client';
import type { BoardSummary, Status, CustomFieldDef, Task, TreeTask } from '../../lib/types';
import { TreeView } from '../components/TreeView';
import { KanbanView } from '../components/KanbanView';
import { CalendarView } from '../components/CalendarView';
import { GanttView } from '../components/GanttView';
import { NewTaskDrawer } from '../components/NewTaskDrawer';
import { TaskDrawer } from './TaskDrawer';
import BoardSettingsDrawer from './BoardSettingsDrawer';

type ViewMode = 'tree' | 'kanban' | 'calendar' | 'gantt';

export default function BoardDetailPage() {
  const { id: boardId = '' } = useParams<{ id: string }>();
  const [board, setBoard] = useState<BoardSummary | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
  const [view, setView] = useState<ViewMode>(() => {
    return (localStorage.getItem(`tasks:view:${boardId}`) as ViewMode) ?? 'tree';
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskStatusId, setNewTaskStatusId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    localStorage.setItem(`tasks:view:${boardId}`, view);
  }, [view, boardId]);

  useEffect(() => {
    if (!boardId) return;
    let aborted = false;
    getBoard(boardId)
      .then(r => {
        if (aborted) return;
        setBoard(r.data.board);
        setStatuses(r.data.statuses);
        setCustomFields(r.data.custom_fields);
      })
      .catch(e => setError((e as Error).message));
    return () => { aborted = true; };
  }, [boardId]);

  useEffect(() => {
    if (!boardId) return;
    let aborted = false;
    setLoading(true);
    // Gantt isn't a server-side view shape; we ask for the flat list
    // and let the client filter into scheduled/unscheduled groups.
    const apiView = view === 'gantt' ? 'flat' : view;
    listTasks(boardId, { view: apiView, hide_done: false })
      .then(r => {
        if (aborted) return;
        if (view === 'kanban') {
          const flat: Task[] = [];
          for (const col of r.data.columns ?? []) flat.push(...col.tasks);
          setTasks(flat);
        } else {
          setTasks((r.data.tasks ?? []) as Task[]);
        }
      })
      .catch(e => setError((e as Error).message))
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [boardId, view]);

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(t => t.title.toLowerCase().includes(q));
  }, [tasks, search]);

  const treeTasks: TreeTask[] = view === 'tree' ? (filteredTasks as TreeTask[]) : [];

  async function refresh() {
    if (!boardId) return;
    const r = await listTasks(boardId, { view, hide_done: false });
    if (view === 'kanban') {
      const flat: Task[] = [];
      for (const col of r.data.columns ?? []) flat.push(...col.tasks);
      setTasks(flat);
    } else {
      setTasks((r.data.tasks ?? []) as Task[]);
    }
  }

  function openNewTask(statusId: string | null = null) {
    setNewTaskStatusId(statusId);
    setNewTaskOpen(true);
  }

  return (
    <Page title={board?.name ?? 'Board'}>
      <Flex direction="column" style={{ height: 'calc(100vh - 56px)' }}>
        <Box px="5" py="4" style={{ borderBottom: '1px solid var(--gray-a5)' }}>
          <Flex justify="between" align="center">
            <Box>
              <Heading size="5">{board?.name ?? 'Loading…'}</Heading>
              {board?.description && (
                <Box mt="1" style={{ color: 'var(--gray-11)', fontSize: 14 }}>
                  {board.description}
                </Box>
              )}
            </Box>
            <Flex gap="2">
              <Button onClick={() => openNewTask(null)}>
                <PlusIcon width="16" height="16" />
                New task
              </Button>
              <Button variant="soft" color="gray" onClick={() => setSettingsOpen(true)}>
                <Cog6ToothIcon width="16" height="16" />
                Settings
              </Button>
            </Flex>
          </Flex>
        </Box>

        <Box px="5" py="3" style={{ borderBottom: '1px solid var(--gray-a5)' }}>
          <Tabs.Root value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <Flex justify="between" align="center" gap="3">
              <Tabs.List>
                <Tabs.Trigger value="tree">Tree</Tabs.Trigger>
                <Tabs.Trigger value="kanban">Kanban</Tabs.Trigger>
                <Tabs.Trigger value="calendar">Calendar</Tabs.Trigger>
                <Tabs.Trigger value="gantt">Gantt</Tabs.Trigger>
              </Tabs.List>
              <Box style={{ flex: 1, maxWidth: 320 }}>
                <TextField.Root
                  placeholder="Search tasks…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </Box>
            </Flex>
          </Tabs.Root>
        </Box>

        <Box style={{ flex: 1, overflow: 'hidden' }}>
          {loading && (
            <Flex justify="center" align="center" style={{ height: '100%' }}>
              <Spinner size="3" />
            </Flex>
          )}
          {error && !loading && (
            <Box p="5">
              <Callout.Root color="red">
                <Callout.Icon><ExclamationTriangleIcon width="16" height="16" /></Callout.Icon>
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            </Box>
          )}
          {!loading && !error && view === 'tree' && (
            <TreeView
              tasks={treeTasks}
              statuses={statuses}
              customFields={customFields}
              onTaskOpen={setDrawerTaskId}
              onTasksChanged={refresh}
            />
          )}
          {!loading && !error && view === 'kanban' && (
            <KanbanView
              tasks={filteredTasks}
              statuses={statuses}
              boardId={boardId}
              onTaskOpen={setDrawerTaskId}
              onTasksChanged={refresh}
              onAddTask={openNewTask}
            />
          )}
          {!loading && !error && view === 'calendar' && (
            <CalendarView tasks={filteredTasks} onTaskOpen={setDrawerTaskId} />
          )}
          {!loading && !error && view === 'gantt' && (
            <GanttView
              tasks={filteredTasks}
              statuses={statuses}
              onTaskOpen={setDrawerTaskId}
              onTasksChanged={refresh}
            />
          )}
        </Box>

        {drawerTaskId && (
          <TaskDrawer
            taskId={drawerTaskId}
            statuses={statuses}
            customFields={customFields}
            onClose={() => setDrawerTaskId(null)}
            onChanged={refresh}
          />
        )}

        <NewTaskDrawer
          boardId={boardId}
          open={newTaskOpen}
          onOpenChange={setNewTaskOpen}
          statuses={statuses}
          defaultStatusId={newTaskStatusId}
          onCreated={refresh}
        />

        <BoardSettingsDrawer
          boardId={boardId}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            // Re-fetch board + statuses + custom fields when settings change.
            getBoard(boardId).then(r => {
              setBoard(r.data.board);
              setStatuses(r.data.statuses);
              setCustomFields(r.data.custom_fields);
            });
          }}
        />
      </Flex>
    </Page>
  );
}
