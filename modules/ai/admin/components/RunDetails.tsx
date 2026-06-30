/**
 * Run details — collapsible provenance panel rendered under an
 * assistant message.
 *
 * Reads `prompt_source` (migration 023) off the message row. Empty +
 * fallback runs are still shown — they're the cases operators most need
 * to see ("why didn't my skill update get picked up?").
 *
 * Stays small + diagnostic — not a styled chip strip, just enough so
 * an operator can glance and answer "which version of the prompt ran?"
 */

import { useState } from 'react';
import type { AiMessage, PromptSourceSnapshot } from '../utils/aiService';

interface Props {
  message: AiMessage;
}

const KIND_LABELS: Record<PromptSourceSnapshot['system_prompt']['kind'], string> = {
  skill: 'Skill',
  recipe: 'Recipe',
  inline: 'Inline use-case prompt',
  empty: 'No prompt configured',
};

const KIND_COLORS: Record<PromptSourceSnapshot['system_prompt']['kind'], string> = {
  skill: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  recipe: 'text-violet-700 bg-violet-50 border-violet-200',
  inline: 'text-blue-700 bg-blue-50 border-blue-200',
  empty: 'text-neutral-600 bg-neutral-50 border-neutral-200',
};

function shortHash(s: string | undefined | null): string {
  if (!s) return '—';
  const h = s.replace(/^sha256:/, '');
  return h.length >= 8 ? h.slice(0, 8) : h;
}

export default function RunDetails({ message }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);

  // For runs without provenance (pre-023 rows or message rows the
  // worker never updated), the panel doesn't render at all — there's
  // nothing to show. Operator can still inspect model/provider via the
  // existing chat bubble metadata.
  if (!message.prompt_source && !message.model) return null;

  const ps = message.prompt_source;
  // A snapshot may be partial (e.g. a synthetic message that only records
  // use_case) — guard every nested access, don't assume the full shape.
  const kind = ps?.system_prompt?.kind ?? 'empty';
  const chipColor = KIND_COLORS[kind];
  const chipLabel = KIND_LABELS[kind];

  return (
    <div className="mt-1 text-xs">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-neutral-500 hover:text-neutral-700"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>Run details</span>
        {ps && (
          <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${chipColor}`}>
            {chipLabel}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 p-3 rounded-md border border-neutral-200 bg-neutral-50 space-y-2">
          <Row label="Use case" value={ps?.use_case ?? '—'} />
          <Row label="Provider / model" value={`${message.provider ?? '—'} / ${message.model ?? '—'}`} />
          <Row label="Tokens (in / out)" value={`${message.input_tokens} / ${message.output_tokens}`} />
          <Row label="Cost (micro-USD)" value={String(message.cost_micro_usd)} />
          <Row label="Latency (ms)" value={String(message.latency_ms)} />
          {ps?.system_prompt && (
            <>
              <hr className="border-neutral-200" />
              <Row label="System prompt source" value={KIND_LABELS[ps.system_prompt.kind]} />
              <Row label="System prompt hash" value={shortHash(ps.system_prompt.content_hash)} />
              <Row label="System prompt chars" value={String(ps.system_prompt.char_count)} />
              {ps.system_prompt.kind === 'skill' && ps.system_prompt.skill && (
                <>
                  <Row
                    label="Skill"
                    value={`${ps.system_prompt.skill.name} (${ps.system_prompt.skill.source_label ?? ps.system_prompt.skill.source_id})`}
                  />
                  <Row label="Skill dir_path" value={ps.system_prompt.skill.dir_path} />
                  <Row label="Skill content hash" value={shortHash(ps.system_prompt.skill.content_hash)} />
                  <Row label="Skill commit" value={shortHash(ps.system_prompt.skill.last_commit_sha)} />
                </>
              )}
              {ps.system_prompt.kind === 'recipe' && ps.system_prompt.recipe && (
                <>
                  <Row
                    label="Recipe"
                    value={`${ps.system_prompt.recipe.title} (${ps.system_prompt.recipe.source_label ?? ps.system_prompt.recipe.source_id})`}
                  />
                  <Row label="Recipe file_path" value={ps.system_prompt.recipe.file_path} />
                  <Row label="Recipe content hash" value={shortHash(ps.system_prompt.recipe.content_hash)} />
                  <Row label="Recipe commit" value={shortHash(ps.system_prompt.recipe.last_commit_sha)} />
                </>
              )}
              {ps.kickoff_message && (
                <Row
                  label="Kickoff message"
                  value={
                    ps.kickoff_message.kind === 'empty'
                      ? 'none'
                      : `${ps.kickoff_message.kind} (${ps.kickoff_message.char_count} chars)`
                  }
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex gap-2 items-baseline">
      <div className="w-40 shrink-0 text-neutral-500">{label}</div>
      <div className="font-mono text-neutral-800 break-all">{value}</div>
    </div>
  );
}
