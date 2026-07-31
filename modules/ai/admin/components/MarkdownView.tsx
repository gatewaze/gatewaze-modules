/**
 * MarkdownView — safe, opt-in Markdown renderer for AI output surfaces.
 *
 * Used by recipe-run "Final output" (behind a Raw/Markdown toggle) and by
 * the chat widget when a host passes `renderMarkdown`. It is deliberately
 * *additive*: nothing routes through here unless a surface opts in, so
 * line-oriented output (logs, diffs, terminal dumps) keeps its raw `<pre>`
 * path untouched.
 *
 * Safety posture:
 *   - No `rehype-raw`. Raw HTML embedded in the markdown source is escaped,
 *     not parsed — so a model (or a recipe author) cannot inject `<script>`,
 *     event handlers, or arbitrary markup into the admin DOM.
 *   - react-markdown's default URL transform neutralises dangerous link
 *     protocols (`javascript:`, `data:`, `vbscript:`), so a `[x](javascript:…)`
 *     link cannot execute.
 *   - No `@radix-ui/themes` import — that would duplicate the Radix singleton
 *     in module builds and crash `useThemeContext` (see CLAUDE.md).
 *
 * The wrapper uses `white-space: pre-wrap` so Markdown soft line breaks
 * (single newlines) are preserved visually rather than collapsed, keeping
 * fidelity with prose that relies on manual line wrapping.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownViewProps {
  /** Raw Markdown source to render. */
  children: string;
  /** Extra classes applied to the wrapper element. */
  className?: string;
}

export default function MarkdownView({ children, className }: MarkdownViewProps): JSX.Element {
  return (
    <div
      className={`markdown-view whitespace-pre-wrap break-words text-sm text-neutral-800 ${className ?? ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-lg font-semibold mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold mt-3 mb-1">{children}</h2>,
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
              className="text-blue-600 underline hover:text-blue-800"
            >
              {children}
            </a>
          ),
          code: ({ children, className: codeClassName }) => {
            // Inline code has no language class; fenced blocks do. Only the
            // fenced form gets the block treatment.
            const isBlock = typeof codeClassName === 'string' && codeClassName.includes('language-');
            if (isBlock) {
              return (
                <code className={`${codeClassName ?? ''} block`}>{children}</code>
              );
            }
            return (
              <code className="rounded bg-neutral-100 px-1 py-0.5 text-xs font-mono">{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="rounded-md bg-neutral-100 border px-3 py-2 text-xs overflow-x-auto my-2">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-neutral-300 pl-3 text-neutral-600 my-1">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="w-full text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border px-2 py-1 bg-neutral-50 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
