/**
 * TranscriptMarkdown — safe Markdown renderer for the Software Engineer runs
 * stream transcript (issue #10). The agent emits GitHub-flavoured Markdown
 * (`##` headings, `**bold**`, lists, fenced code, tables); the transcript
 * previously rendered it as raw pre-wrapped text, so the markup showed as
 * literal source. This routes both completed messages and the live in-progress
 * bubble through react-markdown, themed with the admin Radix gray vars so the
 * component stays self-contained (no runtime dependency on the `ai` module).
 *
 * Safety posture (mirrors modules/ai/admin/components/MarkdownView.tsx):
 *   - No `rehype-raw`. Raw HTML in the Markdown source is escaped, not parsed,
 *     so agent (or admin) output cannot inject `<script>`, event handlers, or
 *     arbitrary markup into the admin DOM.
 *   - react-markdown's default URL transform neutralises dangerous link
 *     protocols (`javascript:`, `data:`, `vbscript:`), so `[x](javascript:…)`
 *     cannot execute.
 *   - No `@radix-ui/themes` import — that duplicates the Radix singleton in
 *     module builds and crashes `useThemeContext` (see CLAUDE.md).
 *
 * The `pre-wrap` wrapper preserves Markdown soft line breaks (single newlines)
 * so line-oriented agent prose keeps its shape.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface TranscriptMarkdownProps {
  /** Raw Markdown source to render. */
  children: string;
  /** Extra classes applied to the wrapper element. */
  className?: string;
  /**
   * When true, the source is a partial (still-streaming) turn: it is passed
   * through {@link normalizeStreamingMarkdown} first so an unterminated code
   * fence or dangling emphasis marker degrades gracefully instead of swallowing
   * the rest of the bubble.
   */
  streaming?: boolean;
}

/**
 * Conservatively repair partial Markdown from an in-flight turn so it renders
 * sensibly before the closing marker has streamed in. Deliberately minimal —
 * it only balances the constructs whose *un*balanced form corrupts everything
 * that follows:
 *   - an odd number of ``` fences (an open fence turns all trailing prose into
 *     one mono code block),
 *   - a dangling inline `` ` `` outside any code block,
 *   - a dangling `**` bold run.
 * Applied ONLY to the streaming bubble; completed messages render verbatim.
 */
export function normalizeStreamingMarkdown(src: string): string {
  if (!src) return src;
  let out = src;

  // 1. Close an unterminated fenced code block. Count fence markers (``` at the
  //    start of a line, optionally after whitespace); an odd count means the
  //    last block is still open.
  const fenceMatches = out.match(/^[ \t]*```/gm);
  const fenceOpen = fenceMatches ? fenceMatches.length % 2 === 1 : false;
  if (fenceOpen) {
    out += (out.endsWith('\n') ? '' : '\n') + '```';
    // Inside a now-closed fence, inline markers are literal — nothing more to do.
    return out;
  }

  // 2/3. Only balance inline markers outside code (there are no open fences at
  //      this point). Strip fenced + inline code spans before counting so code
  //      contents never trigger a false balance.
  const outsideCode = out.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

  if ((outsideCode.match(/`/g)?.length ?? 0) % 2 === 1) out += '`';
  if ((outsideCode.match(/\*\*/g)?.length ?? 0) % 2 === 1) out += '**';

  return out;
}

export default function TranscriptMarkdown({
  children,
  className,
  streaming,
}: TranscriptMarkdownProps): JSX.Element {
  const source = streaming ? normalizeStreamingMarkdown(children) : children;
  return (
    <div className={`markdown-view whitespace-pre-wrap break-words text-[var(--gray-12)] ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
          p: ({ children }) => <p className="my-1">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 underline hover:text-blue-400"
            >
              {children}
            </a>
          ),
          code: ({ children, className: codeClassName }) => {
            // Inline code has no language class; fenced blocks do. Only the
            // fenced form gets the block treatment.
            const isBlock = typeof codeClassName === 'string' && codeClassName.includes('language-');
            if (isBlock) {
              return <code className={`${codeClassName ?? ''} block`}>{children}</code>;
            }
            return (
              <code className="rounded bg-[var(--gray-3)] px-1 py-0.5 text-xs font-mono">{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="rounded-md bg-[var(--gray-3)] border border-[var(--gray-6)] px-3 py-2 text-xs overflow-x-auto my-2">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--gray-6)] pl-3 text-[var(--gray-11)] my-1">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="w-full text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--gray-6)] px-2 py-1 bg-[var(--gray-2)] text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--gray-6)] px-2 py-1 align-top">{children}</td>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
