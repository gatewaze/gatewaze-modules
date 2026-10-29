import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import {
  updateBroadcast, EVENT_VARIABLES, MAX_SLACK_MESSAGE_CHARS, SLACK_MERGE_FIELDS, type Broadcast,
} from '../lib/broadcastService';
import { fillSampleValues, parseSlackMessage, type InlinePart } from '../lib/slackPreview';

const inputCls = 'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

function Inline({ part }: { part: InlinePart }) {
  switch (part.kind) {
    case 'bold': return <strong>{part.text}</strong>;
    case 'italic': return <em>{part.text}</em>;
    case 'strike': return <s>{part.text}</s>;
    case 'code': return <code className="rounded bg-[var(--gray-3)] px-1 text-[0.85em] text-[var(--red-11)]">{part.text}</code>;
    case 'link': return <a href={part.href} target="_blank" rel="noopener noreferrer" className="text-[var(--blue-11)] hover:underline">{part.text}</a>;
    default: return <>{part.text}</>;
  }
}

export function SlackMessagePreview({ text, senderName }: { text: string; senderName: string }) {
  const blocks = parseSlackMessage(fillSampleValues(text));
  return (
    <div className="flex gap-2">
      <div className="h-9 w-9 shrink-0 rounded-md bg-[var(--accent-9)]" aria-hidden />
      <div className="min-w-0 text-[15px] leading-relaxed text-[var(--gray-12)]">
        <div className="text-sm font-bold">{senderName} <span className="font-normal text-xs text-[var(--gray-10)]">now</span></div>
        {blocks.length === 0 || !text.trim()
          ? <p className="text-sm text-[var(--gray-9)]">Your message will appear here.</p>
          : blocks.map((b, i) => {
            if (b.kind === 'code') return <pre key={i} className="my-1 whitespace-pre-wrap rounded border border-[var(--gray-5)] bg-[var(--gray-2)] p-2 text-xs">{b.text}</pre>;
            const content = b.parts.length ? b.parts.map((p, j) => <Inline key={j} part={p} />) : <br />;
            if (b.kind === 'quote') return <div key={i} className="border-l-4 border-[var(--gray-6)] pl-2">{content}</div>;
            return <div key={i} className="whitespace-pre-wrap break-words">{content}</div>;
          })}
      </div>
    </div>
  );
}

/**
 * The Content step for a Slack broadcast: the message text (Slack mrkdwn,
 * saved to broadcasts.body_text) with a live preview.
 */
export function SlackMessageEditor({ b, editable, setHeaderActions, onSaved, onProceedToSending, extra }: {
  b: Broadcast;
  editable: boolean;
  setHeaderActions: (n: ReactNode) => void;
  onSaved: (b: Broadcast) => void;
  onProceedToSending: () => void;
  extra?: ReactNode;
}) {
  const [text, setText] = useState(b.body_text ?? '');
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const dirty = text !== (b.body_text ?? '');
  const tooLong = text.length > MAX_SLACK_MESSAGE_CHARS;

  useEffect(() => { setText(b.body_text ?? ''); }, [b.body_text]);

  async function save(andContinue: boolean) {
    if (tooLong) { toast.error(`Slack messages can be at most ${MAX_SLACK_MESSAGE_CHARS.toLocaleString()} characters`); return; }
    setSaving(true);
    try {
      const nb = await updateBroadcast(b.id, { body_text: text } as Partial<Broadcast>);
      onSaved(nb);
      toast.success('Message saved');
      if (andContinue) onProceedToSending();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save the message');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!editable) { setHeaderActions(null); return () => setHeaderActions(null); }
    setHeaderActions(
      <div className="flex items-center gap-2">
        <Button variant="soft" onClick={() => save(false)} disabled={saving || !dirty || tooLong}>{saving ? 'Saving…' : 'Save'}</Button>
        <Button variant="solid" onClick={() => save(true)} disabled={saving || tooLong || !text.trim()}>Save &amp; continue</Button>
      </div>,
    );
    return () => setHeaderActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, saving, dirty, tooLong, text]);

  function insert(token: string) {
    const el = area.current;
    if (!el) { setText((t) => t + token); return; }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + token + text.slice(end);
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  }

  const tokens = [...SLACK_MERGE_FIELDS, ...(b.event_id ? EVENT_VARIABLES.map((v) => v.token) : [])];

  return (
    <div className="space-y-3">
      {extra}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="slack-message" className="block text-sm font-medium text-[var(--gray-12)]">Message</label>
          <textarea
            id="slack-message"
            ref={area}
            className={`${inputCls} min-h-[320px] font-mono`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!editable}
            placeholder={'Hi {{first_name}}, …'}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[var(--gray-10)]">Insert:</span>
              {tokens.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={!editable}
                  onClick={() => insert(t)}
                  className="rounded border border-[var(--gray-6)] px-1.5 py-0.5 font-mono text-[var(--gray-11)] hover:bg-[var(--gray-3)]"
                >
                  {t}
                </button>
              ))}
            </div>
            <span className={tooLong ? 'font-medium text-[var(--red-11)]' : 'text-[var(--gray-10)]'}>
              {text.length.toLocaleString()} / {MAX_SLACK_MESSAGE_CHARS.toLocaleString()}
            </span>
          </div>
          <p className="text-xs text-[var(--gray-10)]">
            Slack formatting: *bold*, _italic_, ~strike~, `code`, &gt; quote, and links as &lt;https://example.com|link text&gt;.
            Merge fields are filled from each person&apos;s profile. Slack messages have no unsubscribe link.
          </p>
        </div>
        <div className="space-y-2">
          <span className="block text-sm font-medium text-[var(--gray-12)]">Preview</span>
          <div className="rounded-lg border border-[var(--gray-5)] bg-[var(--color-surface)] p-4">
            <SlackMessagePreview text={text} senderName={b.slack_sender === 'welcome_sender' ? 'Welcome-DM account' : 'Workspace bot'} />
          </div>
          <p className="text-xs text-[var(--gray-10)]">Merge fields show sample values. Link previews (unfurls) are added by Slack when the message is sent.</p>
        </div>
      </div>
    </div>
  );
}
