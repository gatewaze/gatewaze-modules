/**
 * Run timeline — pure logic for the interactive "watch the agent" view
 * (spec §14.1). Merges the two realtime streams the run detail API returns —
 * `se_events` (assistant text, tool_use, tool_result, …) and `se_messages`
 * (admin ↔ agent chat) — into one chronologically-ordered list of render
 * "steps", and classifies each so the UI can pick a presentation:
 *
 *   - message      → chat bubble (admin / agent / system)
 *   - assistant    → the agent's thinking-out-loud prose
 *   - tool         → a tool invocation; file writes/edits become document cards
 *   - tool_result  → the (already-truncated) result summary
 *   - note         → thinking / status / gate and any future event kind
 *
 * Kept free of React so it is unit-testable under the module's node vitest
 * config (no jsdom). The component in SoftwareEngineerTab renders these.
 */

export interface RawEvent {
  id: number | string;
  kind: string;
  payload?: Record<string, unknown> | null;
  seq?: number | null;
  phase?: string | null;
  created_at?: string | null;
}

export interface RawMessage {
  id: number | string;
  role: string;
  content: string;
  sub_session_id?: string | null;
  created_at?: string | null;
}

export interface DocEdit {
  filePath: string;
  /** Full new file contents (Write). */
  content?: string;
  /** Edit diff halves (Edit). */
  oldString?: string;
  newString?: string;
  isMarkdown: boolean;
}

export type TimelineStep =
  | { type: 'message'; key: string; at: number; role: string; content: string; subSessionId: string | null }
  | { type: 'assistant'; key: string; at: number; text: string; agent: string | null }
  | { type: 'tool'; key: string; at: number; name: string; input: Record<string, unknown>; agent: string | null; label: string; doc: DocEdit | null }
  | { type: 'tool_result'; key: string; at: number; summary: string }
  | { type: 'note'; key: string; at: number; kind: string; text: string };

/** Tools whose invocation is worth showing as an expandable document card. */
const DOC_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const MD_RE = /\.(md|markdown|mdx)$/i;

export function isMarkdownPath(p: unknown): boolean {
  return typeof p === 'string' && MD_RE.test(p);
}

export function basename(p: unknown): string {
  if (typeof p !== 'string' || p === '') return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Parse a tool_use payload's input into a document-card descriptor, if it is one. */
export function docFromTool(name: string, input: Record<string, unknown> | undefined | null): DocEdit | null {
  if (!input || !DOC_TOOLS.has(name)) return null;
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? '';
  if (!filePath) return null;
  const isMarkdown = isMarkdownPath(filePath);
  if (name === 'Write' || name === 'NotebookEdit') {
    return { filePath, content: str(input.content) ?? str(input.new_source) ?? '', isMarkdown };
  }
  // Edit / MultiEdit: surface the first replacement so the card can show a diff.
  const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : null;
  const first = edits?.[0];
  return {
    filePath,
    oldString: str(input.old_string) ?? str(first?.old_string) ?? '',
    newString: str(input.new_string) ?? str(first?.new_string) ?? '',
    isMarkdown,
  };
}

/** A short, human "current activity" label for a tool invocation. */
export function describeTool(name: string, input: Record<string, unknown> | undefined | null): string {
  const p = input ?? {};
  const file = () => basename(str(p.file_path) ?? str(p.notebook_path) ?? str(p.path));
  switch (name) {
    case 'Write': return `Writing ${file()}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `Editing ${file()}`;
    case 'Read': return `Reading ${file()}`;
    case 'Bash': {
      const cmd = (str(p.command) ?? '').replace(/\s+/g, ' ').trim();
      return cmd ? `Running: ${cmd.slice(0, 48)}${cmd.length > 48 ? '…' : ''}` : 'Running a command';
    }
    case 'Grep':
    case 'Glob': {
      const pat = str(p.pattern);
      return pat ? `Searching “${pat.slice(0, 40)}”` : 'Searching the code';
    }
    case 'Task': return 'Delegating to a subagent';
    default: return name || 'Working';
  }
}

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Merge events + messages into a single chronological list of steps.
 * Primary order is `created_at`; ties are broken deterministically so that
 * realtime re-fetches never reshuffle already-shown steps (events keep their
 * `seq` order, messages their `id` order, and events sort before messages at
 * the same instant).
 */
export function buildTimeline(events: RawEvent[] = [], messages: RawMessage[] = []): TimelineStep[] {
  interface Tagged { step: TimelineStep; source: 0 | 1; ord: number }
  const rows: Tagged[] = [];

  for (const ev of events) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const at = toMs(ev.created_at);
    const ord = typeof ev.seq === 'number' ? ev.seq : 0;
    const key = `e${ev.id}`;
    if (ev.kind === 'assistant') {
      const text = str(payload.text) ?? '';
      if (!text.trim()) continue;
      rows.push({ source: 0, ord, step: { type: 'assistant', key, at, text, agent: str(payload.agent) ?? null } });
    } else if (ev.kind === 'tool_use') {
      const name = str(payload.name) ?? 'tool';
      const input = (payload.input ?? {}) as Record<string, unknown>;
      rows.push({
        source: 0, ord,
        step: { type: 'tool', key, at, name, input, agent: str(payload.agent) ?? null, label: describeTool(name, input), doc: docFromTool(name, input) },
      });
    } else if (ev.kind === 'tool_result') {
      const summary = str(payload.summary) ?? '';
      if (!summary.trim()) continue;
      rows.push({ source: 0, ord, step: { type: 'tool_result', key, at, summary } });
    } else {
      // thinking / status / gate / anything new.
      const text = str(payload.text) ?? str(payload.summary) ?? str(payload.message) ?? '';
      rows.push({ source: 0, ord, step: { type: 'note', key, at, kind: ev.kind, text } });
    }
  }

  for (const m of messages) {
    const at = toMs(m.created_at);
    const ord = typeof m.id === 'number' ? m.id : 0;
    rows.push({
      source: 1, ord,
      step: { type: 'message', key: `m${m.id}`, at, role: m.role, content: m.content ?? '', subSessionId: m.sub_session_id ?? null },
    });
  }

  rows.sort((a, b) => (a.step.at - b.step.at) || (a.source - b.source) || (a.ord - b.ord));
  return rows.map((r) => r.step);
}

/**
 * The label for the live "current activity" ticker. Walks back from the end
 * to the most recent meaningful action so a burst of tool_results at the tail
 * doesn't blank the ticker.
 */
export function currentActivity(steps: TimelineStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === 'tool') return s.label;
    if (s.type === 'assistant') return 'Thinking…';
    if (s.type === 'message' && s.role === 'agent') return 'Replying…';
  }
  return 'Working…';
}
