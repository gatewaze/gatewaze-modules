/**
 * Run timeline pure-logic tests. Fits the module's node vitest config
 * (`environment: 'node'`, no jsdom) — these functions never touch React.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTimeline, docFromTool, describeTool, isMarkdownPath, basename, currentActivity,
} from '../../admin/lib/timeline';

describe('isMarkdownPath / basename', () => {
  it('detects markdown extensions', () => {
    expect(isMarkdownPath('docs/SPEC.md')).toBe(true);
    expect(isMarkdownPath('README.markdown')).toBe(true);
    expect(isMarkdownPath('notes.MDX')).toBe(true);
    expect(isMarkdownPath('src/index.ts')).toBe(false);
    expect(isMarkdownPath(null as any)).toBe(false);
  });
  it('extracts the file name from a path', () => {
    expect(basename('a/b/c/SPEC.md')).toBe('SPEC.md');
    expect(basename('flat.txt')).toBe('flat.txt');
    expect(basename('')).toBe('');
  });
});

describe('docFromTool', () => {
  it('maps a Write to a full-content doc card', () => {
    const doc = docFromTool('Write', { file_path: 'docs/SPEC.md', content: '# Hi' });
    expect(doc).toEqual({ filePath: 'docs/SPEC.md', content: '# Hi', isMarkdown: true });
  });
  it('maps an Edit to a diff doc card', () => {
    const doc = docFromTool('Edit', { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' });
    expect(doc).toEqual({ filePath: 'a.ts', oldString: 'foo', newString: 'bar', isMarkdown: false });
  });
  it('reads the first edit of a MultiEdit', () => {
    const doc = docFromTool('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] });
    expect(doc?.oldString).toBe('x');
    expect(doc?.newString).toBe('y');
  });
  it('returns null for non-document tools', () => {
    expect(docFromTool('Bash', { command: 'ls' })).toBeNull();
    expect(docFromTool('Read', { file_path: 'a.ts' })).toBeNull();
  });
  it('returns null when file_path is missing', () => {
    expect(docFromTool('Write', { content: 'x' })).toBeNull();
  });
});

describe('describeTool', () => {
  it('produces human labels per tool', () => {
    expect(describeTool('Write', { file_path: 'x/SPEC.md' })).toBe('Writing SPEC.md');
    expect(describeTool('Edit', { file_path: 'x/a.ts' })).toBe('Editing a.ts');
    expect(describeTool('Read', { file_path: 'x/a.ts' })).toBe('Reading a.ts');
    expect(describeTool('Bash', { command: 'npm test' })).toBe('Running: npm test');
    expect(describeTool('Grep', { pattern: 'foo' })).toBe('Searching “foo”');
    expect(describeTool('Weird', {})).toBe('Weird');
  });
  it('truncates long bash commands', () => {
    const long = 'echo ' + 'a'.repeat(100);
    expect(describeTool('Bash', { command: long }).endsWith('…')).toBe(true);
  });
});

describe('buildTimeline', () => {
  const events = [
    { id: 1, kind: 'assistant', seq: 0, created_at: '2026-07-31T10:00:00Z', payload: { text: 'Let me look' } },
    { id: 2, kind: 'tool_use', seq: 1, created_at: '2026-07-31T10:00:02Z', payload: { name: 'Write', input: { file_path: 'SPEC.md', content: '# Hi' } } },
    { id: 3, kind: 'tool_result', seq: 2, created_at: '2026-07-31T10:00:03Z', payload: { summary: 'wrote file' } },
    { id: 4, kind: 'assistant', seq: 3, created_at: '2026-07-31T10:00:04Z', payload: { text: '   ' } }, // blank → dropped
    { id: 5, kind: 'status', seq: 4, created_at: '2026-07-31T10:00:05Z', payload: { message: 'phase started' } },
  ];
  const messages = [
    { id: 10, role: 'admin', content: 'go', created_at: '2026-07-31T10:00:01Z', sub_session_id: null },
    { id: 11, role: 'agent', content: 'on it', created_at: '2026-07-31T10:00:06Z', sub_session_id: null },
  ];

  it('merges chronologically by created_at', () => {
    const t = buildTimeline(events, messages);
    const keys = t.map((s) => s.key);
    // e1(10:00:00) m10(10:00:01) e2(10:00:02) e3(10:00:03) [e4 dropped] e5(10:00:05) m11(10:00:06)
    expect(keys).toEqual(['e1', 'm10', 'e2', 'e3', 'e5', 'm11']);
  });

  it('classifies each step and attaches doc cards to file tools', () => {
    const t = buildTimeline(events, messages);
    const write = t.find((s) => s.key === 'e2') as any;
    expect(write.type).toBe('tool');
    expect(write.doc.filePath).toBe('SPEC.md');
    expect(write.doc.isMarkdown).toBe(true);
    expect(t.find((s) => s.key === 'e5')?.type).toBe('note');
  });

  it('drops blank assistant text', () => {
    const t = buildTimeline(events, messages);
    expect(t.some((s) => s.key === 'e4')).toBe(false);
  });

  it('is stable for events sharing a timestamp (orders by seq, events before messages)', () => {
    const sameTs = [
      { id: 1, kind: 'assistant', seq: 5, created_at: '2026-07-31T10:00:00Z', payload: { text: 'b' } },
      { id: 2, kind: 'assistant', seq: 2, created_at: '2026-07-31T10:00:00Z', payload: { text: 'a' } },
    ];
    const msgs = [{ id: 9, role: 'admin', content: 'm', created_at: '2026-07-31T10:00:00Z', sub_session_id: null }];
    const keys = buildTimeline(sameTs, msgs).map((s) => s.key);
    expect(keys).toEqual(['e2', 'e1', 'm9']);
  });

  it('handles empty input', () => {
    expect(buildTimeline()).toEqual([]);
    expect(buildTimeline([], [])).toEqual([]);
  });
});

describe('currentActivity', () => {
  it('reports the most recent tool label, skipping trailing results', () => {
    const t = buildTimeline([
      { id: 1, kind: 'tool_use', seq: 0, created_at: '2026-07-31T10:00:00Z', payload: { name: 'Edit', input: { file_path: 'SPEC.md' } } },
      { id: 2, kind: 'tool_result', seq: 1, created_at: '2026-07-31T10:00:01Z', payload: { summary: 'ok' } },
    ], []);
    expect(currentActivity(t)).toBe('Editing SPEC.md');
  });
  it('falls back to Working when nothing actionable', () => {
    expect(currentActivity([])).toBe('Working…');
  });
});
