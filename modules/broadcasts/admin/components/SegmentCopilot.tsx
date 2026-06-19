import { useState, useRef, useEffect } from 'react';
import { SparklesIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import type { SegmentDefinition } from '@/lib/segments';
import { buildSegmentFromPrompt } from '../lib/broadcastService';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  warnings?: string[];
  count?: number | null;
}

interface Props {
  brand?: string;
  /** The running definition (held by the parent, also editable in the builder).
   *  Passed back to the copilot each turn so follow-ups REFINE it. */
  currentDefinition: SegmentDefinition | null;
  /** Called whenever the copilot produces/updates a definition. */
  onDefinition: (def: SegmentDefinition, meta: { suggestedName?: string }) => void;
}

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

const SUGGESTIONS = [
  'Everyone who attended the last San Francisco Forum event',
  'All people in New York and the surrounding area',
  'Job title contains "machine learning engineer"',
  'People at tech companies who registered for an event in the last 90 days',
];

/**
 * Conversational segment copilot — mirrors the editor copilot chat UX. The
 * admin describes the audience, the model emits a segment definition (shown +
 * editable in the SegmentBuilder on the right), and follow-up messages REFINE
 * the running definition (e.g. "change job title to 'machine learning eng'").
 */
export default function SegmentCopilot({ brand, currentDefinition, onDefinition }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send(text: string) {
    const trimmed = text.trim();
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
      setMessages((m) => [...m, {
        id: nextId(), role: 'assistant',
        text: r.explanation || 'Updated the audience criteria on the right.',
        warnings: r.warnings, count: r.count,
      }]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copilot failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[420px]">
      <div ref={scrollRef} className="flex-1 overflow-auto space-y-3 pr-1">
        {messages.length === 0 ? (
          <div className="text-center py-8">
            <SparklesIcon className="h-8 w-8 text-[var(--accent-9)] mx-auto mb-2" />
            <p className="text-sm text-[var(--gray-12)] font-medium mb-1">Describe your audience</p>
            <p className="text-xs text-[var(--gray-10)] mb-4">I’ll build the criteria — then you can refine by chatting or editing them directly.</p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} disabled={busy}
                  className="block w-full text-left text-xs px-3 py-2 rounded-md border border-[var(--gray-6)] text-[var(--gray-11)] hover:bg-[var(--gray-3)]">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--accent-9)] text-white px-3 py-2 text-sm'
                  : 'max-w-[90%] rounded-2xl rounded-bl-sm bg-[var(--gray-3)] text-[var(--gray-12)] px-3 py-2 text-sm'
              }>
                <div>{m.text}</div>
                {typeof m.count === 'number' && (
                  <div className="text-xs mt-1 opacity-80">≈ {m.count.toLocaleString()} people match</div>
                )}
                {m.warnings && m.warnings.length > 0 && (
                  <ul className="text-xs mt-1 list-disc pl-4 text-[var(--amber-11)]">
                    {m.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>
            </div>
          ))
        )}
        {busy && <div className="flex justify-start"><div className="rounded-2xl bg-[var(--gray-3)] px-3 py-2 text-sm text-[var(--gray-10)]">Thinking…</div></div>}
      </div>

      <div className="mt-3 flex gap-2 items-end">
        <textarea
          className="flex-1 rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm resize-none"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(prompt); } }}
          placeholder={messages.length === 0 ? 'e.g. everyone in New York…' : 'Refine — e.g. “change job title to machine learning eng”'}
        />
        <Button variant="solid" onClick={() => send(prompt)} disabled={busy || !prompt.trim()}>
          <PaperAirplaneIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
