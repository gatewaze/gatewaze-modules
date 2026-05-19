/**
 * GanttView — project-timeline visualisation alongside Tree / Kanban /
 * Calendar (spec §7.x — adds a 4th view).
 *
 * Bars are draggable: drag the body to shift both start_date and
 * due_date, drag the left edge to change start_date, drag the right
 * edge to change due_date. On drop we PATCH the task and the view
 * refreshes via `onTasksChanged`. Optimistic preview during drag.
 *
 * The chart fills its container width and horizontally scrolls when
 * the timeline overflows. The left task-name column is sticky so it
 * stays visible while scrolling.
 *
 * Zoom levels: Day (40px/day) / Week (16px/day) / Month (6px/day).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Badge,
  Button,
  Flex,
  Heading,
  Text,
} from '@radix-ui/themes';
import { toast } from 'sonner';
import { patchTask } from '../lib/api-client';
import type { Status, Task, Uuid } from '../../lib/types';

interface Props {
  tasks: Task[];
  statuses: Status[];
  onTaskOpen: (id: Uuid) => void;
  onTasksChanged?: () => void;
}

type Zoom = 'day' | 'week' | 'month';
const PX_PER_DAY: Record<Zoom, number> = { day: 40, week: 16, month: 6 };

const MS_PER_DAY = 86_400_000;
const LEFT_COL_WIDTH = 280;
const ROW_HEIGHT = 36;
const HEADER_HEIGHT = 56;
const EDGE_HIT_PX = 6;

type DragMode = 'move' | 'resize-left' | 'resize-right';

interface DragState {
  taskId: Uuid;
  mode: DragMode;
  startClientX: number;
  origStartDays: number;   // offset from rangeStart (days)
  origEndDays: number;     // inclusive end offset from rangeStart (days)
  previewStartDays: number;
  previewEndDays: number;
}

export function GanttView({ tasks, statuses, onTaskOpen, onTasksChanged }: Props) {
  const [zoom, setZoom] = useState<Zoom>('week');
  const [drag, setDrag] = useState<DragState | null>(null);

  const statusMap = useMemo(() => new Map(statuses.map(s => [s.id, s])), [statuses]);

  const { scheduled, unscheduled } = useMemo(() => {
    const sched: Task[] = [];
    const un: Task[] = [];
    for (const t of tasks) {
      if (t.due_date) sched.push(t);
      else un.push(t);
    }
    sched.sort((a, b) => {
      const aStart = a.start_date ?? a.due_date!;
      const bStart = b.start_date ?? b.due_date!;
      return aStart < bStart ? -1 : aStart > bStart ? 1 : 0;
    });
    return { scheduled: sched, unscheduled: un };
  }, [tasks]);

  const { rangeStart, rangeEnd, days } = useMemo(() => {
    const today = startOfDay(new Date());
    let min = new Date(today.getTime() - 14 * MS_PER_DAY);
    let max = new Date(today.getTime() + 14 * MS_PER_DAY);
    for (const t of scheduled) {
      const s = t.start_date ? new Date(t.start_date) : new Date(t.due_date!);
      const e = new Date(t.due_date!);
      if (s < min) min = s;
      if (e > max) max = e;
    }
    min = new Date(min.getTime() - 3 * MS_PER_DAY);
    max = new Date(max.getTime() + 3 * MS_PER_DAY);
    const totalDays = Math.ceil((max.getTime() - min.getTime()) / MS_PER_DAY) + 1;
    const arr: Date[] = [];
    for (let i = 0; i < totalDays; i++) {
      arr.push(new Date(min.getTime() + i * MS_PER_DAY));
    }
    return { rangeStart: min, rangeEnd: max, days: arr };
  }, [scheduled]);

  const px = PX_PER_DAY[zoom];
  const timelineWidth = days.length * px;
  const todayOffsetDays = Math.floor(
    (startOfDay(new Date()).getTime() - rangeStart.getTime()) / MS_PER_DAY,
  );

  // Global mouse listeners while dragging so the bar continues to
  // update even if the cursor leaves the bar element.
  useEffect(() => {
    if (!drag) return;
    function onMove(ev: MouseEvent) {
      setDrag(prev => {
        if (!prev) return prev;
        const deltaPx = ev.clientX - prev.startClientX;
        const deltaDays = Math.round(deltaPx / px);
        if (prev.mode === 'move') {
          return {
            ...prev,
            previewStartDays: prev.origStartDays + deltaDays,
            previewEndDays: prev.origEndDays + deltaDays,
          };
        }
        if (prev.mode === 'resize-left') {
          const next = Math.min(prev.origStartDays + deltaDays, prev.origEndDays);
          return { ...prev, previewStartDays: next };
        }
        // resize-right
        const next = Math.max(prev.origEndDays + deltaDays, prev.previewStartDays);
        return { ...prev, previewEndDays: next };
      });
    }
    async function onUp() {
      // Commit if anything actually changed.
      setDrag(current => {
        if (!current) return null;
        const changed =
          current.previewStartDays !== current.origStartDays ||
          current.previewEndDays !== current.origEndDays;
        if (changed) {
          void commit(current);
        }
        return null;
      });
    }
    async function commit(state: DragState) {
      const newStart = dateFromOffset(rangeStart, state.previewStartDays);
      const newEnd = dateFromOffset(rangeStart, state.previewEndDays);
      try {
        await patchTask(state.taskId, {
          start_date: toIsoDate(newStart),
          due_date: toIsoDate(newEnd),
        });
        onTasksChanged?.();
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, px, rangeStart, onTasksChanged]);

  if (tasks.length === 0) {
    return (
      <Flex justify="center" align="center" style={{ height: '100%' }}>
        <Text size="2" color="gray">No tasks yet — create one to see it on the timeline.</Text>
      </Flex>
    );
  }

  function startDrag(task: Task, mode: DragMode, ev: React.MouseEvent) {
    ev.stopPropagation();
    ev.preventDefault();
    const start = task.start_date ? new Date(task.start_date) : new Date(task.due_date!);
    const end = new Date(task.due_date!);
    const startOffset = Math.floor(
      (startOfDay(start).getTime() - rangeStart.getTime()) / MS_PER_DAY,
    );
    const endOffset = Math.floor(
      (startOfDay(end).getTime() - rangeStart.getTime()) / MS_PER_DAY,
    );
    setDrag({
      taskId: task.id,
      mode,
      startClientX: ev.clientX,
      origStartDays: startOffset,
      origEndDays: endOffset,
      previewStartDays: startOffset,
      previewEndDays: endOffset,
    });
  }

  return (
    <Flex direction="column" style={{ height: '100%', width: '100%' }}>
      <Flex justify="between" align="center" px="4" py="3" style={{ borderBottom: '1px solid var(--gray-a5)' }}>
        <Box>
          <Heading size="3">
            {rangeStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {' – '}
            {rangeEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </Heading>
          <Text size="1" color="gray">{scheduled.length} scheduled · {unscheduled.length} need dates</Text>
        </Box>
        <Flex gap="1">
          {(['day', 'week', 'month'] as const).map(z => (
            <Button
              key={z}
              variant={zoom === z ? 'solid' : 'soft'}
              color={zoom === z ? undefined : 'gray'}
              size="1"
              onClick={() => setZoom(z)}
            >
              {z.charAt(0).toUpperCase() + z.slice(1)}
            </Button>
          ))}
        </Flex>
      </Flex>

      {unscheduled.length > 0 && (
        <Box style={{ borderBottom: '1px solid var(--gray-a5)', flexShrink: 0 }}>
          <Box px="4" py="2" style={{ backgroundColor: 'var(--gray-a3)' }}>
            <Text size="1" weight="medium" color="gray">
              Schedule needed ({unscheduled.length})
            </Text>
          </Box>
          <Flex direction="column">
            {unscheduled.map(t => (
              <UnscheduledRow
                key={t.id}
                task={t}
                status={t.status_id ? statusMap.get(t.status_id) ?? null : null}
                onOpen={() => onTaskOpen(t.id)}
              />
            ))}
          </Flex>
        </Box>
      )}

      <Box style={{ flex: 1, width: '100%', overflow: 'auto' }}>
        <Box style={{ display: 'flex', width: LEFT_COL_WIDTH + timelineWidth, minWidth: '100%' }}>
          {/* Sticky left task name column */}
          <Box
            style={{
              position: 'sticky',
              left: 0,
              zIndex: 2,
              width: LEFT_COL_WIDTH,
              flexShrink: 0,
              backgroundColor: 'var(--color-background)',
              borderRight: '1px solid var(--gray-a5)',
            }}
          >
            <Box style={{ height: HEADER_HEIGHT, borderBottom: '1px solid var(--gray-a5)' }} />
            {scheduled.map(t => (
              <Box
                key={t.id}
                onClick={() => onTaskOpen(t.id)}
                style={{
                  height: ROW_HEIGHT,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 12px',
                  borderBottom: '1px solid var(--gray-a3)',
                  cursor: 'pointer',
                  overflow: 'hidden',
                }}
              >
                <Text
                  size="2"
                  style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textDecoration: t.is_done ? 'line-through' : 'none',
                    color: t.is_done ? 'var(--gray-9)' : 'inherit',
                  }}
                >
                  {t.title}
                </Text>
              </Box>
            ))}
          </Box>

          {/* Timeline */}
          <Box style={{ width: timelineWidth, position: 'relative', flexShrink: 0 }}>
            <DateHeader days={days} px={px} zoom={zoom} />

            {/* Grid lines + today marker (background) */}
            <Box
              style={{
                position: 'absolute',
                top: HEADER_HEIGHT,
                left: 0,
                right: 0,
                bottom: 0,
                pointerEvents: 'none',
              }}
            >
              {days.map((d, i) => {
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <Box
                    key={i}
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: i * px,
                      width: px,
                      backgroundColor: isWeekend ? 'var(--gray-a2)' : 'transparent',
                      borderRight: '1px solid var(--gray-a3)',
                    }}
                  />
                );
              })}
              {todayOffsetDays >= 0 && todayOffsetDays < days.length && (
                <Box
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: todayOffsetDays * px,
                    width: 2,
                    backgroundColor: 'var(--red-9)',
                    zIndex: 1,
                  }}
                />
              )}
            </Box>

            {/* Task bars */}
            <Box style={{ position: 'relative' }}>
              {scheduled.map(t => {
                const status = t.status_id ? statusMap.get(t.status_id) ?? null : null;
                const isDragging = drag?.taskId === t.id;
                let startOffsetDays: number;
                let endOffsetDays: number;
                if (isDragging && drag) {
                  startOffsetDays = drag.previewStartDays;
                  endOffsetDays = drag.previewEndDays;
                } else {
                  const start = t.start_date ? new Date(t.start_date) : new Date(t.due_date!);
                  const end = new Date(t.due_date!);
                  startOffsetDays = Math.floor(
                    (startOfDay(start).getTime() - rangeStart.getTime()) / MS_PER_DAY,
                  );
                  endOffsetDays = Math.floor(
                    (startOfDay(end).getTime() - rangeStart.getTime()) / MS_PER_DAY,
                  );
                }
                const durationDays = Math.max(1, endOffsetDays - startOffsetDays + 1);
                const barWidth = Math.max(durationDays * px - 2, 8);
                return (
                  <Box
                    key={t.id}
                    style={{
                      height: ROW_HEIGHT,
                      position: 'relative',
                      borderBottom: '1px solid var(--gray-a3)',
                    }}
                  >
                    <Box
                      onMouseDown={(ev) => {
                        // Decide drag mode from where in the bar the user grabbed.
                        const target = ev.currentTarget;
                        const rect = target.getBoundingClientRect();
                        const offset = ev.clientX - rect.left;
                        if (offset <= EDGE_HIT_PX) startDrag(t, 'resize-left', ev);
                        else if (offset >= rect.width - EDGE_HIT_PX) startDrag(t, 'resize-right', ev);
                        else startDrag(t, 'move', ev);
                      }}
                      onClick={(ev) => {
                        // Only treat as click if no drag actually happened
                        // (drag clears itself on mouseup before click fires
                        // if a meaningful delta occurred).
                        if (!drag) onTaskOpen(t.id);
                        ev.stopPropagation();
                      }}
                      title={`${t.title} — drag to move, drag edges to resize`}
                      style={{
                        position: 'absolute',
                        top: 8,
                        height: 20,
                        left: startOffsetDays * px,
                        width: barWidth,
                        backgroundColor: statusVarBg(status, t.is_done),
                        borderRadius: 'var(--radius-2)',
                        cursor: isDragging ? cursorFor(drag!.mode) : 'grab',
                        display: 'flex',
                        alignItems: 'center',
                        padding: `0 ${EDGE_HIT_PX + 2}px`,
                        overflow: 'hidden',
                        opacity: t.is_done ? 0.6 : 1,
                        boxShadow: isDragging ? '0 2px 8px var(--gray-a8)' : undefined,
                        userSelect: 'none',
                      }}
                    >
                      {/* Left resize handle */}
                      <Box
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: EDGE_HIT_PX,
                          cursor: 'ew-resize',
                        }}
                      />
                      <Text
                        size="1"
                        weight="medium"
                        style={{
                          color: 'var(--accent-contrast)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          pointerEvents: 'none',
                        }}
                      >
                        {t.title}
                      </Text>
                      {/* Right resize handle */}
                      <Box
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: EDGE_HIT_PX,
                          cursor: 'ew-resize',
                        }}
                      />
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      </Box>
    </Flex>
  );
}

function cursorFor(mode: DragMode): string {
  if (mode === 'move') return 'grabbing';
  return 'ew-resize';
}

function UnscheduledRow({
  task, status, onOpen,
}: { task: Task; status: Status | null; onOpen: () => void }) {
  return (
    <Box
      onClick={onOpen}
      style={{
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 8,
        cursor: 'pointer',
        borderBottom: '1px solid var(--gray-a3)',
      }}
    >
      <Text
        size="2"
        style={{
          flex: 1,
          textDecoration: task.is_done ? 'line-through' : 'none',
          color: task.is_done ? 'var(--gray-9)' : 'inherit',
        }}
      >
        {task.title}
      </Text>
      {status && (
        <Badge color="gray" variant="soft" size="1">{status.name}</Badge>
      )}
    </Box>
  );
}

function DateHeader({ days, px, zoom }: { days: Date[]; px: number; zoom: Zoom }) {
  const monthGroups = useMemo(() => {
    const groups: { label: string; start: number; count: number }[] = [];
    let cur: { key: string; start: number; count: number; label: string } | null = null;
    days.forEach((d, i) => {
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!cur || cur.key !== key) {
        if (cur) groups.push({ label: cur.label, start: cur.start, count: cur.count });
        cur = {
          key,
          start: i,
          count: 0,
          label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        };
      }
      cur.count += 1;
    });
    if (cur) groups.push({ label: cur.label, start: cur.start, count: cur.count });
    return groups;
  }, [days]);

  return (
    <Box
      style={{
        height: HEADER_HEIGHT,
        position: 'sticky',
        top: 0,
        zIndex: 2,
        backgroundColor: 'var(--color-background)',
        borderBottom: '1px solid var(--gray-a5)',
      }}
    >
      {/* Month strip */}
      <Box style={{ position: 'relative', height: 28, borderBottom: '1px solid var(--gray-a3)' }}>
        {monthGroups.map((g, idx) => (
          <Box
            key={idx}
            style={{
              position: 'absolute',
              left: g.start * px,
              width: g.count * px,
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              padding: '0 6px',
              borderRight: '1px solid var(--gray-a3)',
            }}
          >
            <Text size="1" weight="medium" color="gray">{g.label}</Text>
          </Box>
        ))}
      </Box>
      {/* Day strip — labels shown only when zoom level gives them room */}
      <Box style={{ position: 'relative', height: 28 }}>
        {days.map((d, i) => {
          const showLabel = zoom === 'day' || (zoom === 'week' && d.getDay() === 1);
          return (
            <Box
              key={i}
              style={{
                position: 'absolute',
                left: i * px,
                width: px,
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                color: 'var(--gray-11)',
                borderRight: '1px solid var(--gray-a3)',
              }}
            >
              {showLabel && (
                <Text size="1">{d.getDate()}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function dateFromOffset(rangeStart: Date, offsetDays: number): Date {
  return new Date(rangeStart.getTime() + offsetDays * MS_PER_DAY);
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function statusVarBg(status: Status | null, isDone: boolean): string {
  if (isDone) return 'var(--gray-9)';
  if (status?.color) return status.color;
  return 'var(--accent-9)';
}
