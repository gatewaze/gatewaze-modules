/**
 * Pre-run provenance bar — shows operators which skill / prompt /
 * commit the chat widget will use BEFORE they click Send.
 *
 * Lives at the top of AiChatWidget's chat area. Mirrors the
 * post-run RunDetails panel so operators see consistent shape
 * before and after — "will use" vs "used".
 *
 * Polls once on mount + on useCase change. Doesn't auto-refresh,
 * because the underlying skill body is sync'd by a webhook + cron and
 * the use-case row is admin-edited — neither changes between mount
 * and the operator clicking Send in a normal flow.
 */

import { useEffect, useState } from 'react';
import {
  getUseCasePromptSource,
  type PromptSourceSnapshot,
} from '../utils/aiService';

interface Props {
  useCase: string;
}

const KIND_LABELS: Record<PromptSourceSnapshot['system_prompt']['kind'], string> = {
  skill: 'Skill',
  inline: 'Inline prompt',
  fallback: 'Hardcoded fallback',
  empty: 'No prompt configured',
};

const KIND_COLORS: Record<PromptSourceSnapshot['system_prompt']['kind'], string> = {
  skill: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  inline: 'text-blue-700 bg-blue-50 border-blue-200',
  fallback: 'text-amber-700 bg-amber-50 border-amber-200',
  empty: 'text-neutral-600 bg-neutral-50 border-neutral-200',
};

function shortHash(s: string | undefined | null): string {
  if (!s) return '—';
  const h = s.replace(/^sha256:/, '');
  return h.length >= 8 ? h.slice(0, 8) : h;
}

export default function ConfiguredPromptBar({ useCase }: Props): JSX.Element | null {
  const [data, setData] = useState<{
    ps: PromptSourceSnapshot | null;
    systemPreview: string;
    kickoffPreview: string;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getUseCasePromptSource(useCase);
        if (!cancelled) {
          setData({
            ps: r.prompt_source,
            systemPreview: r.system_prompt_preview,
            kickoffPreview: r.kickoff_message_preview,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [useCase]);

  if (error) {
    return (
      <div className="px-3 py-1.5 text-xs text-red-600 bg-red-50 border-b border-red-100">
        Prompt-source preview failed: {error}
      </div>
    );
  }
  if (!data) return null;

  const ps = data.ps;
  const kind = ps?.system_prompt.kind ?? 'empty';
  const chipColor = KIND_COLORS[kind];
  const chipLabel = KIND_LABELS[kind];

  // Build the one-liner summary that's always visible.
  let summary = '';
  if (ps?.system_prompt.kind === 'skill' && ps.system_prompt.skill) {
    const skill = ps.system_prompt.skill;
    const sourceTag = skill.source_label
      ? `${skill.source_label}`
      : skill.source_id.slice(0, 8);
    summary = `${skill.name} · ${sourceTag} @ ${shortHash(skill.last_commit_sha)}`;
  } else if (ps?.system_prompt.kind === 'inline') {
    summary = `inline (${ps.system_prompt.char_count} chars, hash ${shortHash(ps.system_prompt.content_hash)})`;
  } else if (ps?.system_prompt.kind === 'fallback') {
    summary = 'using hardcoded fallback prompt — skill_path may be stale';
  } else {
    summary = 'no prompt configured (use case has no skill + no inline prompt)';
  }

  return (
    <div className="border-b border-neutral-200 bg-neutral-50">
      <button
        type="button"
        className="w-full px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-neutral-100"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="text-neutral-500">Will run with</span>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${chipColor}`}>
          {chipLabel}
        </span>
        <span className="font-mono text-neutral-800 truncate flex-1 text-left">{summary}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 pt-1 text-xs space-y-1 border-t border-neutral-200 bg-white">
          <Row label="Use case" value={ps?.use_case ?? '—'} />
          <Row label="System prompt source" value={KIND_LABELS[kind]} />
          {ps && (
            <>
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
              {ps.system_prompt.kind === 'fallback' && ps.system_prompt.note && (
                <Row label="Note" value={ps.system_prompt.note} />
              )}
              <Row
                label="Kickoff message"
                value={
                  ps.kickoff_message.kind === 'empty'
                    ? 'none'
                    : `${ps.kickoff_message.kind} (${ps.kickoff_message.char_count} chars)`
                }
              />
              {data.systemPreview.length > 0 && (
                <details className="pt-1">
                  <summary className="cursor-pointer text-neutral-500">System prompt preview (first 280 chars)</summary>
                  <pre className="mt-1 p-2 bg-neutral-50 border border-neutral-200 rounded text-[11px] whitespace-pre-wrap break-words text-neutral-700">
                    {data.systemPreview}
                  </pre>
                </details>
              )}
              {data.kickoffPreview.length > 0 && (
                <details className="pt-1">
                  <summary className="cursor-pointer text-neutral-500">Kickoff message preview</summary>
                  <pre className="mt-1 p-2 bg-neutral-50 border border-neutral-200 rounded text-[11px] whitespace-pre-wrap break-words text-neutral-700">
                    {data.kickoffPreview}
                  </pre>
                </details>
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
