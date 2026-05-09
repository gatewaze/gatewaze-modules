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

import { Heading, Section } from '@react-email/components';
import type { EmailBlockEntry } from '../registry-types.js';
import { HelixAiFieldAdapter } from '../helix-ai-field-adapter.js';

// Import the adapter eagerly. An earlier draft used React.lazy + a
// Suspense boundary so the registry's import graph stayed node-test-
// friendly (the adapter pulls AiContentField → react-dom which the
// node-env vitest run can't resolve). That broke Puck v0.21's
// AutoFieldInternal: its useMemo for FieldComponent doesn't tolerate
// a child throwing a Promise during the first render of a custom
// field, and threw `Field type for custom did not exist`. The
// import-graph concern is now handled at the test layer instead
// (vitest.config.ts aliases react-dom → a flushSync-noop stub).

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
      render: HelixAiFieldAdapter as never,
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
