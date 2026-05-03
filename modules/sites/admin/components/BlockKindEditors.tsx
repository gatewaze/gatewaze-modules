/**
 * Editor surfaces per block kind.
 *
 * Per spec-content-modules-git-architecture §9.5:
 *   static               → standard JSON-Schema form
 *   ai-generated         → prompt template editor + cadence + Regenerate button
 *   gatewaze-internal    → query builder UI specific to the source entity
 *   user-personalized    → query builder scoped to current-user context
 *   external-fetched     → endpoint config + secret picker + test-fetch (v1.x)
 *   embed                → provider picker + URL/ID + iframe size (v1.x)
 *   computed             → input source picker + transform config (v1.x)
 *
 * The editor dispatches on block_kind. All kinds share drag-and-drop
 * palette + reorder + delete UX (in PageEditor.tsx); only the per-instance
 * config form differs and is rendered here.
 */

import type { ReactNode } from 'react';
import { Badge, Button, Input, Select } from '@/components/ui';
import { ArrowPathIcon } from '@heroicons/react/24/outline';

export type BlockKind =
  | 'static'
  | 'ai-generated'
  | 'gatewaze-internal'
  | 'user-personalized'
  | 'external-fetched'
  | 'embed'
  | 'computed';

export interface BlockDefSummary {
  id: string;
  name: string;
  block_kind: BlockKind;
  audience: 'public' | 'authenticated' | 'authenticated_optional';
  freshness: 'live' | 'build-time' | null;
  /** JSON Schema for the per-instance kind_config (null for `static` blocks). */
  kind_config_schema: Record<string, unknown> | null;
  /** Compliance categories required to render. */
  requires_consent: string[] | null;
  /** Marker-derived attributes (cadence, model, source, provider, …). */
  kind_attributes?: Record<string, string>;
}

export interface BlockInstance {
  id: string;
  block_def_id: string;
  /** Static content (rendered into HTML for static + ai-generated blocks once generated). */
  content: Record<string, unknown> | null;
  /** Per-instance kind_config conforming to block_def.kind_config_schema. */
  kind_config: Record<string, unknown> | null;
  last_generated_at: string | null;
  generation_status: 'fresh' | 'stale' | 'pending' | 'failed' | null;
}

export interface BlockKindEditorProps {
  blockDef: BlockDefSummary;
  instance: BlockInstance;
  onContentChange: (content: Record<string, unknown>) => void;
  onKindConfigChange: (config: Record<string, unknown>) => void;
  /** Trigger a regenerate for ai-generated blocks. */
  onRegenerate?: () => void;
}

// ---------------------------------------------------------------------------
// Kind dispatch
// ---------------------------------------------------------------------------

export function BlockKindEditor(props: BlockKindEditorProps): ReactNode {
  switch (props.blockDef.block_kind) {
    case 'static':
      return <StaticBlockEditor {...props} />;
    case 'ai-generated':
      return <AiGeneratedBlockEditor {...props} />;
    case 'gatewaze-internal':
      return <GatewazeInternalBlockEditor {...props} />;
    case 'user-personalized':
      return <UserPersonalizedBlockEditor {...props} />;
    case 'external-fetched':
      return <ExternalFetchedBlockEditor {...props} />;
    case 'embed':
      return <EmbedBlockEditor {...props} />;
    case 'computed':
      return <ComputedBlockEditor {...props} />;
    default:
      return <UnsupportedBlockEditor kind={props.blockDef.block_kind} />;
  }
}

// ---------------------------------------------------------------------------
// Per-kind editors (v1: static / ai-generated / gatewaze-internal / user-personalized)
// ---------------------------------------------------------------------------

function StaticBlockEditor({ blockDef, instance, onContentChange }: BlockKindEditorProps) {
  // For static blocks, the content schema is the editor surface. Reuses
  // the schema-driven form already in the schema-editor module.
  // For now: stub showing JSON; full implementation via SchemaEditor.tsx.
  return (
    <div className="space-y-3">
      <div className="text-xs text-[var(--gray-a8)]">Block content (schema-driven form)</div>
      <textarea
        value={JSON.stringify(instance.content ?? {}, null, 2)}
        onChange={(e) => {
          try {
            onContentChange(JSON.parse(e.target.value));
          } catch {
            /* let the user keep typing; only commit valid JSON */
          }
        }}
        className="w-full h-48 px-3 py-2 font-mono text-sm bg-[var(--gray-a2)] rounded-md border border-[var(--gray-a4)]"
      />
    </div>
  );
}

function AiGeneratedBlockEditor({ blockDef, instance, onKindConfigChange, onRegenerate }: BlockKindEditorProps) {
  const cadence = blockDef.kind_attributes?.cadence ?? 'before-publish';
  const model = blockDef.kind_attributes?.model ?? 'claude-sonnet';
  const config = (instance.kind_config ?? {}) as { prompt?: string };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-[var(--gray-a8)]">
        <Badge variant="soft" color="purple" size="1">AI</Badge>
        <span>cadence: {cadence}</span>
        <span>•</span>
        <span>model: {model}</span>
        {instance.last_generated_at && (
          <>
            <span>•</span>
            <span>last generated {timeAgo(instance.last_generated_at)}</span>
          </>
        )}
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Prompt template</label>
        <textarea
          value={config.prompt ?? ''}
          onChange={(e) => onKindConfigChange({ ...config, prompt: e.target.value })}
          placeholder="Use {{ variables }} from the page/edition context."
          className="w-full h-32 px-3 py-2 text-sm bg-[var(--gray-a2)] rounded-md border border-[var(--gray-a4)]"
        />
      </div>
      {instance.content !== null && (
        <div>
          <div className="text-xs text-[var(--gray-a8)] mb-1">Last generated content (editable)</div>
          <textarea
            value={JSON.stringify(instance.content, null, 2)}
            readOnly
            className="w-full h-32 px-3 py-2 font-mono text-xs bg-[var(--gray-a2)] rounded-md border border-[var(--gray-a4)] text-[var(--gray-a9)]"
          />
        </div>
      )}
      <Button onClick={onRegenerate} disabled={instance.generation_status === 'pending'} variant="outlined">
        <ArrowPathIcon className="size-4" />
        {instance.generation_status === 'pending' ? 'Generating…' : 'Regenerate now'}
      </Button>
    </div>
  );
}

function GatewazeInternalBlockEditor({ blockDef, instance, onKindConfigChange }: BlockKindEditorProps) {
  const source = blockDef.kind_attributes?.source ?? 'unknown';
  const config = (instance.kind_config ?? {}) as { filter?: Record<string, unknown>; sort?: string; limit?: number };
  const freshness = blockDef.freshness ?? 'live';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-[var(--gray-a8)]">
        <Badge variant="soft" color="blue" size="1">Internal</Badge>
        <span>source: {source}</span>
        <span>•</span>
        <span>freshness: {freshness}</span>
      </div>
      <p className="text-sm text-[var(--gray-a8)]">
        Query builder for source <code>{source}</code> not yet rendered. v1 surface is a
        JSON config; the per-source query-builder UI from the source provider's
        registration is a follow-up.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1">Query config (JSON)</label>
        <textarea
          value={JSON.stringify(config, null, 2)}
          onChange={(e) => {
            try {
              onKindConfigChange(JSON.parse(e.target.value));
            } catch {
              /* user typing */
            }
          }}
          className="w-full h-32 px-3 py-2 font-mono text-sm bg-[var(--gray-a2)] rounded-md border border-[var(--gray-a4)]"
        />
      </div>
    </div>
  );
}

function UserPersonalizedBlockEditor({ blockDef, instance, onKindConfigChange }: BlockKindEditorProps) {
  const config = (instance.kind_config ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs text-[var(--gray-a8)]">
        <Badge variant="soft" color="orange" size="1">Personalized</Badge>
        <span>audience: {blockDef.audience}</span>
      </div>
      <p className="text-sm text-[var(--gray-a8)]">
        Per-user content. Configured against the current user's session at request time;
        no admin override of which user.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1">Per-user query config</label>
        <textarea
          value={JSON.stringify(config, null, 2)}
          onChange={(e) => {
            try {
              onKindConfigChange(JSON.parse(e.target.value));
            } catch {
              /* user typing */
            }
          }}
          className="w-full h-32 px-3 py-2 font-mono text-sm bg-[var(--gray-a2)] rounded-md border border-[var(--gray-a4)]"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// v1.x kinds — show "deferred" placeholder so the editor doesn't crash
// ---------------------------------------------------------------------------

function ExternalFetchedBlockEditor({ blockDef }: BlockKindEditorProps) {
  return <DeferredBlockEditor kind="external-fetched" name={blockDef.name} />;
}
function EmbedBlockEditor({ blockDef }: BlockKindEditorProps) {
  return <DeferredBlockEditor kind="embed" name={blockDef.name} />;
}
function ComputedBlockEditor({ blockDef }: BlockKindEditorProps) {
  return <DeferredBlockEditor kind="computed" name={blockDef.name} />;
}

function DeferredBlockEditor({ kind, name }: { kind: string; name: string }) {
  return (
    <div className="p-4 rounded-md bg-yellow-50 border border-yellow-200">
      <p className="text-sm font-medium text-yellow-900">Block kind <code>{kind}</code> ships in v1.x</p>
      <p className="text-xs text-yellow-800 mt-1">
        The block <strong>{name}</strong> declares <code>kind={kind}</code> in its marker,
        but its editor surface is part of a follow-up release.
      </p>
    </div>
  );
}

function UnsupportedBlockEditor({ kind }: { kind: string }) {
  return (
    <div className="p-4 rounded-md bg-red-50 border border-red-200">
      <p className="text-sm font-medium text-red-900">Unsupported block kind: <code>{kind}</code></p>
      <p className="text-xs text-red-800 mt-1">
        This block declares a kind not recognized by gatewaze. Check the marker's <code>kind</code> attribute.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const ms = Date.now() - d;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}
