/**
 * Helix AI Content email block — optional heading + AI-generated body.
 *
 * Was originally the "AI Content Section" block created by the Newsletter
 * Setup Wizard's Basic Template option; ported to react-email primitives
 * and rebranded around the Helix integration that powers the
 * "research-and-draft" affordance.
 *
 * The `ai_body` field uses an inline custom Puck render that mounts
 * `AiContentField` via `helix-ai-field-adapter.tsx`. The adapter bridges
 * Puck's per-field `(value, onChange)` API to AiContentField's
 * multi-key shape — the field writes to ai_body, ai_body_helix_task_id,
 * ai_body_prompt, ai_body_helix_project_id, and
 * ai_body_helix_output_imported_at on the same block. The edge functions
 * (`helix-task-create`, `helix-output-sync`) write to those flat keys
 * server-side, so we keep them flat here too.
 *
 * Note: `componentId` stays `'ai_section'` (NOT renamed to
 * `'helix_ai_content'`) for data stability — existing newsletter rows
 * carry component_id='ai_section' and the wizard inserts that key.
 * Renaming the on-disk file/symbol/label is cosmetic.
 */

import { lazy, Suspense, type ReactNode } from 'react';
import { Heading, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';

// Lazy-load the field adapter so node-only test runs (the registry
// shape tests, the export-edition-html tests, etc.) don't pull
// `react-dom`/`@/components/ui/RichTextEditor` into the import graph
// at module-load time. The adapter renders only when Puck mounts the
// custom field — i.e. inside the editor (browser env), where the
// admin's deps are present.
const HelixAiFieldAdapterLazy = lazy(() =>
  import('../helix-ai-field-adapter.js').then((m) => ({ default: m.HelixAiFieldAdapter })),
);

interface HelixAiContentProps extends Record<string, unknown> {
  title: string;
  ai_body: string;
}

export const HelixAiContentBlock: EmailBlockEntry<HelixAiContentProps> = {
  componentId: 'ai_section',
  label: 'Helix AI Content',
  category: 'Content',
  fields: {
    title: { type: 'text', label: 'Section title (optional)' },
    ai_body: {
      type: 'custom',
      label: 'Body (Helix AI-generated)',
      render: (props: { value: unknown; onChange: (v: unknown) => void; name?: string; id?: string }): ReactNode => (
        <Suspense fallback={null}>
          <HelixAiFieldAdapterLazy {...props} />
        </Suspense>
      ),
    },
  },
  defaultProps: {
    title: '',
    ai_body: '<p>Click <strong>Research and Draft with Helix</strong> to fill in AI content.</p>',
  },
  Component: ({ title, ai_body }) => (
    <Section style={{ padding: '20px 40px' }}>
      {title ? (
        <Heading as="h2" style={{ fontSize: '22px', fontWeight: 'bold', color: '#1a1a2e', margin: '0 0 16px' }}>
          {title}
        </Heading>
      ) : null}
      <div
        style={{ fontSize: '16px', lineHeight: 1.6, color: '#333' }}
        dangerouslySetInnerHTML={{ __html: typeof ai_body === 'string' ? ai_body : '' }}
      />
    </Section>
  ),
  formats: {
    substack: ({ title, ai_body }) => (
      <>
        {title ? <h2>{title}</h2> : null}
        <div dangerouslySetInnerHTML={{ __html: ai_body ?? '' }} />
      </>
    ),
    beehiiv: ({ title, ai_body }) => (
      <>
        {title ? <h2>{title}</h2> : null}
        <div dangerouslySetInnerHTML={{ __html: ai_body ?? '' }} />
      </>
    ),
  },
};
