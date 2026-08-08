// @ts-nocheck
/**
 * Per-phase engine + model resolution (migration 013). One function decides what runs a phase, with
 * explicit precedence so behaviour is predictable and testable:
 *
 *   1. run overrides   — parsed once at intake from issue labels (agent:model:*, agent:engine:*);
 *                        pin the whole run.
 *   2. escalation      — run.model_escalated (latched by the ladder in pr-monitor/revise) swaps
 *                        CODE phases onto project.escalationModel. Claude engine only: escalation
 *                        exists to buy capability, and cross-engine retry changes too many
 *                        variables at once to attribute the fix.
 *   3. phase map       — project.phaseModels[phase] ({engine, model}, both optional).
 *   4. project default — claude engine, project.model.
 *
 * The codex engine is limited to REPO phases (spec/review/implement/revise/verify): triage, reflect
 * and the review-KB are single no-tools JSON turns built around the Claude Agent SDK's noTools seam,
 * which the Codex CLI has no equivalent for. An invalid/unauthorised codex resolution falls back to
 * claude rather than failing the run — routing must never be the reason a run dies.
 *
 * `ci-classify` (pr-monitor's pre-fix-pass CI classifier) is a cheap utility phase, same category as
 * `triage`/`reflect` — not in ESCALATION_PHASES or CODEX_PHASES. It always resolves to the plain
 * claude default unless a project maps `phaseModels['ci-classify']` to something cheaper.
 */

export type Engine = 'claude' | 'codex';
export interface EngineModel { engine: Engine; model: string }

// Phases the escalation ladder re-routes (the code-writing loop). Intentionally excludes triage/
// reflect/review-kb (cheap, never the bottleneck) and intake/pr/merge (no model at all).
export const ESCALATION_PHASES = new Set(['spec', 'review', 'implement', 'revise', 'verify']);
// Phases the codex engine may run (repo work; everything else needs the claude noTools seam).
export const CODEX_PHASES = new Set(['spec', 'review', 'implement', 'revise', 'verify']);

// Conservative shape for anything that ends up as a --model / API model id. Rejects whitespace,
// shell metacharacters, and label junk without needing to track every provider's id scheme.
const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

export function normalizeModel(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = MODEL_ALIASES[s] ?? s;
  return MODEL_ID.test(m) ? m : null;
}

function normalizeEngine(raw: unknown): Engine | null {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'claude' || s === 'codex' ? s : null;
}

/** Parse agent:model:<alias|id> / agent:engine:<claude|codex> from an issue's labels. Unknown or
 *  malformed values are ignored (labels are repo-collaborator input, not trusted config). */
export function parseOverrideLabels(labels: string[]): { model?: string; engine?: Engine } {
  const out: { model?: string; engine?: Engine } = {};
  for (const l of labels ?? []) {
    const name = String(l ?? '');
    if (name.startsWith('agent:model:')) {
      const m = normalizeModel(name.slice('agent:model:'.length));
      if (m) out.model = m;
    } else if (name.startsWith('agent:engine:')) {
      const e = normalizeEngine(name.slice('agent:engine:'.length));
      if (e) out.engine = e;
    }
  }
  return out;
}

/**
 * Resolve what runs `phase`. `run` may be null for project-level turns (triage copilot, review-KB)
 * — those never see run overrides or escalation. The result is guaranteed usable: a codex
 * resolution is only returned when the phase allows it AND the project holds an OpenAI credential;
 * otherwise it degrades to claude on the same model rules.
 */
export function resolvePhaseModel(project: any, run: any | null, phase: string): EngineModel {
  const def: EngineModel = { engine: 'claude', model: normalizeModel(project?.model) ?? 'claude-sonnet-5' };

  const map = (project?.phaseModels && typeof project.phaseModels === 'object' ? project.phaseModels[phase] : null) ?? null;
  let engine = normalizeEngine(map?.engine) ?? def.engine;
  let model = normalizeModel(map?.model) ?? def.model;

  // Escalation latch (code phases only). Overrides the phase map — the ladder exists because the
  // mapped model already failed.
  if (run?.model_escalated && ESCALATION_PHASES.has(phase)) {
    const esc = normalizeModel(project?.escalationModel);
    if (esc) { engine = 'claude'; model = esc; }
  }

  // Per-run label overrides win over everything.
  const roEngine = normalizeEngine(run?.engine_override);
  const roModel = normalizeModel(run?.model_override);
  if (roEngine) engine = roEngine;
  if (roModel) model = roModel;

  // Codex guardrails: allowed phase + credential present, else degrade to claude. When the engine
  // falls back but the requested model was an OpenAI id, drop to the claude default model too —
  // a codex model name means nothing to the claude engine.
  if (engine === 'codex' && (!CODEX_PHASES.has(phase) || !project?.openaiCred)) {
    engine = 'claude';
    if (!model.startsWith('claude-')) model = def.model;
  }
  if (engine === 'claude' && !model.startsWith('claude-')) model = def.model;

  return { engine, model };
}
