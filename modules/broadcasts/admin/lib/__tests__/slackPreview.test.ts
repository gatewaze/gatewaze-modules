import { describe, it, expect } from 'vitest';
import { fillSampleValues, parseInline, parseSlackMessage } from '../slackPreview';

describe('parseInline', () => {
  it('reads Slack formatting and links', () => {
    expect(parseInline('Hi *you*, see <https://aaif.live/vaf|the forum> or https://x.io _now_ ~not~ `code`')).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'bold', text: 'you' },
      { kind: 'text', text: ', see ' },
      { kind: 'link', href: 'https://aaif.live/vaf', text: 'the forum' },
      { kind: 'text', text: ' or ' },
      { kind: 'link', href: 'https://x.io', text: 'https://x.io' },
      { kind: 'text', text: ' ' },
      { kind: 'italic', text: 'now' },
      { kind: 'text', text: ' ' },
      { kind: 'strike', text: 'not' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'code' },
    ]);
  });

  it('never makes a link from a non-http URL', () => {
    const parts = parseInline('<javascript:alert(1)|click>');
    expect(parts.every((p) => p.kind !== 'link')).toBe(true);
  });

  it('shows escaped characters as Slack does', () => {
    expect(parseInline('a &amp; b &lt;c&gt;')).toEqual([{ kind: 'text', text: 'a & b <c>' }]);
  });
});

describe('parseSlackMessage', () => {
  it('splits lines, quotes and code blocks', () => {
    const blocks = parseSlackMessage('Hello\n> quoted\n```\nline 1\nline 2\n```\nbye');
    expect(blocks.map((b) => b.kind)).toEqual(['line', 'quote', 'code', 'line']);
    expect(blocks[2]).toEqual({ kind: 'code', text: 'line 1\nline 2' });
  });

  it('handles a one-line code block', () => {
    expect(parseSlackMessage('```x = 1```')).toEqual([{ kind: 'code', text: 'x = 1' }]);
  });
});

describe('fillSampleValues', () => {
  it('fills known fields and leaves others', () => {
    expect(fillSampleValues('Hi {{first_name}} {{ company|"you"}} {{event_name}}')).toBe('Hi Alex Acme {{event_name}}');
  });
});
