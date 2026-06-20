import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { toast } from 'sonner';
import type { SegmentDefinition } from '@/lib/segments';
import { buildSegmentFromPrompt } from '../lib/broadcastService';

/**
 * Audience copilot — visually mirrors the newsletter editor AI panel
 * (editor-ai-copilot/admin/components/AiSidebarPane.tsx): a centered
 * "What do you want to build?" composer in the empty state, chat bubbles +
 * a pinned composer once the conversation starts. Single panel — the segment
 * it builds is described in the chat and saved via the header action.
 *
 * Multi-turn: each follow-up passes the running definition back so the copilot
 * REFINES it (e.g. "change job title to machine learning eng").
 */

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  warnings?: string[];
  count?: number | null;
}

interface Props {
  brand?: string;
  currentDefinition: SegmentDefinition | null;
  onDefinition: (def: SegmentDefinition, meta: { suggestedName?: string }) => void;
}

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

const SUGGESTIONS = [
  'Everyone who attended the last San Francisco Forum event',
  'All people in New York',
  'Job titles containing "machine learning engineer"',
  'People at companies in the US who registered for an event in the last 90 days',
];

// Styling ported from AiSidebarPane's `S` object so the panel looks identical.
const S = {
  rootInitial: { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minHeight: 0, padding: 12, gap: 12, fontSize: 13, lineHeight: 1.4, color: 'var(--gray-12)', boxSizing: 'border-box' } as CSSProperties,
  rootChat: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--gray-12)', boxSizing: 'border-box' } as CSSProperties,
  headerBar: { padding: '12px 14px 10px', fontSize: 14, fontWeight: 600, color: 'var(--gray-12)', borderBottom: '1px solid var(--gray-5)' } as CSSProperties,
  messages: { flex: 1, overflowY: 'auto', padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 } as CSSProperties,
  userBubble: { alignSelf: 'flex-end', maxWidth: '85%', padding: '8px 12px', fontSize: 13, lineHeight: 1.45, color: 'var(--gray-12)', background: 'var(--accent-4)', borderRadius: 14, borderTopRightRadius: 4, wordBreak: 'break-word' } as CSSProperties,
  assistantLine: { alignSelf: 'flex-start', maxWidth: '95%', fontSize: 13, lineHeight: 1.5, color: 'var(--gray-11)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as CSSProperties,
  metaLine: { fontSize: 11, color: 'var(--gray-10)', marginTop: 4 } as CSSProperties,
  footer: { padding: '8px 12px 12px', borderTop: '1px solid var(--gray-5)', display: 'flex', flexDirection: 'column', gap: 8 } as CSSProperties,
  footerInitial: { padding: 0, borderTop: 'none', display: 'flex', flexDirection: 'column', gap: 10 } as CSSProperties,
  composer: { display: 'flex', flexDirection: 'column', border: '1px solid var(--gray-7)', borderRadius: 14, background: 'var(--color-surface)', overflow: 'hidden', transition: 'border-color 120ms ease, box-shadow 120ms ease' } as CSSProperties,
  composerFocused: { borderColor: 'var(--accent-8)', boxShadow: '0 0 0 1px var(--accent-8)' } as CSSProperties,
  textarea: { width: '100%', minHeight: 56, maxHeight: 260, padding: '12px 14px', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45, color: 'inherit', background: 'transparent', border: 'none', outline: 'none', resize: 'none', boxSizing: 'border-box' } as CSSProperties,
  actionsRow: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px 8px 8px' } as CSSProperties,
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, background: 'transparent', border: '1px solid transparent', borderRadius: 8, cursor: 'pointer', color: 'var(--gray-11)' } as CSSProperties,
  sendButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, marginLeft: 'auto', padding: 0, color: '#fff', background: 'var(--accent-9)', border: '1px solid transparent', borderRadius: '50%', cursor: 'pointer' } as CSSProperties,
  sendButtonDisabled: { opacity: 0.4, cursor: 'not-allowed' } as CSSProperties,
};

function SendIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>;
}

export default function SegmentCopilot({ brand, currentDefinition, onDefinition }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  // Auto-grow the textarea (matches the editor composer).
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  }, [prompt]);

  async function send(text?: string) {
    const trimmed = (text ?? prompt).trim();
    if (!trimmed || busy) return;
    setPrompt('');
    setMessages((m) => [...m, { id: nextId(), role: 'user', text: trimmed }]);
    setBusy(true);
    try {
      const r = await buildSegmentFromPrompt(trimmed, { brand, currentDefinition });
      if (!r.success || !r.definition) {
        setMessages((m) => [...m, { id: nextId(), role: 'assistant', text: r.error || 'I couldn’t build that — try rephrasing.' }]);
        return;
      }
      onDefinition(r.definition, { suggestedName: r.suggested_name });
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', text: r.explanation || 'Updated the audience criteria.', warnings: r.warnings, count: r.count }]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copilot failed');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const canSend = !!prompt.trim();
  const isInitial = messages.length === 0 && !busy;

  const composer = (
    <div style={{ ...S.composer, ...(focused ? S.composerFocused : {}) }}>
      <textarea
        ref={textareaRef}
        rows={2}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Describe your audience…"
        maxLength={2000}
        style={S.textarea}
        autoFocus={isInitial}
      />
      <div style={S.actionsRow}>
        <button type="button" aria-label="Send prompt" onClick={() => send()} disabled={!canSend || busy}
          style={{ ...S.sendButton, ...(!canSend || busy ? S.sendButtonDisabled : {}) }}>
          <SendIcon />
        </button>
      </div>
    </div>
  );

  if (isInitial) {
    return (
      <div style={S.rootInitial} role="region" aria-label="Audience copilot">
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14, padding: '8px 4px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--gray-12)' }}>Describe your audience</div>
            <div style={{ fontSize: 13, color: 'var(--gray-10)', marginTop: 2 }}>
              Tell the copilot who should receive this broadcast — it builds the criteria, and you can refine by chatting.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => send(s)}
                style={{ textAlign: 'left', fontSize: 13, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--gray-6)', background: 'var(--color-surface)', color: 'var(--gray-11)', cursor: 'pointer' }}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div style={S.footerInitial}>{composer}</div>
      </div>
    );
  }

  return (
    <div style={S.rootChat} role="region" aria-label="Audience copilot">
      <div style={S.headerBar}>Audience builder</div>
      <div style={S.messages} aria-live="polite">
        {messages.map((m) => (
          m.role === 'user'
            ? <div key={m.id} style={S.userBubble}>{m.text}</div>
            : (
              <div key={m.id} style={S.assistantLine}>
                <div>{m.text}</div>
                {typeof m.count === 'number' && <div style={S.metaLine}>≈ {m.count.toLocaleString()} people match</div>}
                {m.warnings && m.warnings.length > 0 && (
                  <ul style={{ ...S.metaLine, paddingLeft: 16, listStyle: 'disc', color: 'var(--amber-11)' }}>
                    {m.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>
            )
        ))}
        {busy && <div style={S.assistantLine}>Thinking…</div>}
        <div ref={messagesEndRef} />
      </div>
      <div style={S.footer}>{composer}</div>
    </div>
  );
}
