/**
 * CalendarView — month grid (spec §7.5).
 * Styled with Radix Theme primitives.
 */

import { useMemo, useState } from 'react';
import { Box, Flex, Heading, IconButton, Button, Text } from '@radix-ui/themes';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import type { Task, Uuid } from '../../lib/types';

interface Props {
  tasks: Task[];
  onTaskOpen: (id: Uuid) => void;
}

export function CalendarView({ tasks, onTaskOpen }: Props) {
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const tasksByDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const day of monthDays) m.set(day.iso, []);
    for (const task of tasks) {
      if (!task.due_date) continue;
      const start = task.start_date ?? task.due_date;
      let cur = new Date(start);
      const end = new Date(task.due_date);
      while (cur <= end) {
        const iso = cur.toISOString().slice(0, 10);
        if (m.has(iso)) m.get(iso)!.push(task);
        cur = new Date(cur.getTime() + 86_400_000);
      }
    }
    return m;
  }, [monthDays, tasks]);

  return (
    <Flex direction="column" style={{ height: '100%' }}>
      <Flex justify="between" align="center" px="4" py="3" style={{ borderBottom: '1px solid var(--gray-a5)' }}>
        <Heading size="3">
          {cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </Heading>
        <Flex gap="1" align="center">
          <IconButton
            variant="soft"
            color="gray"
            onClick={() => setCursor(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
          >
            <ChevronLeftIcon width="16" height="16" />
          </IconButton>
          <Button
            variant="soft"
            color="gray"
            onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          >
            Today
          </Button>
          <IconButton
            variant="soft"
            color="gray"
            onClick={() => setCursor(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
          >
            <ChevronRightIcon width="16" height="16" />
          </IconButton>
        </Flex>
      </Flex>

      <Box style={{ flex: 1, overflow: 'auto' }}>
        <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
            <Box key={d} px="2" py="1" style={{
              borderRight: '1px solid var(--gray-a3)',
              borderBottom: '1px solid var(--gray-a5)',
              textAlign: 'center',
            }}>
              <Text size="1" color="gray" weight="medium">{d}</Text>
            </Box>
          ))}
        </Box>
        <Box style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridAutoRows: '120px',
        }}>
          {monthDays.map(day => {
            const dayTasks = tasksByDay.get(day.iso) ?? [];
            return (
              <Box
                key={day.iso}
                p="1"
                style={{
                  borderRight: '1px solid var(--gray-a3)',
                  borderBottom: '1px solid var(--gray-a3)',
                  backgroundColor: day.outsideMonth ? 'var(--gray-a2)' : 'transparent',
                  overflow: 'hidden',
                }}
              >
                <Text size="1" color={day.outsideMonth ? 'gray' : undefined} weight="medium">
                  {day.outsideMonth ? '' : day.day}
                </Text>
                <Flex direction="column" gap="1" mt="1">
                  {dayTasks.slice(0, 4).map(t => (
                    <Box
                      key={t.id}
                      onClick={() => onTaskOpen(t.id)}
                      style={{
                        padding: '2px 6px',
                        fontSize: 11,
                        borderRadius: 'var(--radius-2)',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textDecoration: t.is_done ? 'line-through' : 'none',
                        backgroundColor: t.is_done ? 'var(--gray-a4)' : 'var(--accent-a4)',
                        color: t.is_done ? 'var(--gray-11)' : 'var(--accent-11)',
                      }}
                    >
                      {t.title}
                    </Box>
                  ))}
                  {dayTasks.length > 4 && (
                    <Text size="1" color="gray">+{dayTasks.length - 4} more</Text>
                  )}
                </Flex>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Flex>
  );
}

interface DayCell {
  iso: string;
  day: number;
  outsideMonth: boolean;
}

function buildMonthGrid(cursor: Date): DayCell[] {
  const out: DayCell[] = [];
  const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const weekday = (firstDay.getDay() + 6) % 7;
  const start = new Date(firstDay);
  start.setDate(start.getDate() - weekday);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push({
      iso: d.toISOString().slice(0, 10),
      day: d.getDate(),
      outsideMonth: d.getMonth() !== cursor.getMonth(),
    });
  }
  return out;
}
