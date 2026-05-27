/**
 * Recipe extension portability classifier.
 *
 * Per spec-ai-workflows-and-skill-interop.md §4.3, every extension a
 * Goose recipe declares is classified into one of three tiers:
 *
 *   Tier 1 — Honoured. The runner sets the extension up and exposes
 *            its tools to the model.
 *   Tier 2 — Persisted as informational metadata; no tools exposed
 *            unless explicitly mapped. Recipes still parse OK.
 *   Tier 3 — Refused. The recipe parses with status='refused' and a
 *            structured unsupported_features payload so the operator
 *            UI can show what's not supported.
 *
 * This module is intentionally a pure classifier — no IO, no
 * supabase, no fetch — so it can be imported by both the parser and
 * the executor without dragging in side-effects.
 */

export type ExtensionTier = 1 | 2 | 3;

export interface ExtensionInput {
  /** Goose extension `type:`. Some Goose YAML uses `kind:` — caller normalises. */
  type?: string;
  /** Goose extension `name:` (e.g., `memory`, `summon`, `web_search`). */
  name?: string;
  /** Tool-use predicate for `summon` — `load` is Tier-2; `delegate` is Tier-3. */
  uses?: string[];
  /** Raw `cmd` field for stdio extensions; only relevant when `type === 'stdio'`. */
  cmd?: string;
  /** Operator-controlled stdio allowlist (resolved from config/ai-recipes.yaml). */
  stdioAllowlist?: string[];
}

export interface TierClassification {
  tier: ExtensionTier;
  /** When tier === 3, a stable feature key for the unsupported_features payload. */
  refusalFeature?:
    | 'tier-3-extension'
    | 'model-driven-branching'
    | 'sandboxed-execution'
    | 'frontend-extension'
    | 'desktop-extension'
    | 'stdio-not-allowlisted';
  /** Human-readable detail string. */
  details?: string;
}

/**
 * Tier-1 extension type/name pairs the runner natively wires up.
 * Mapped to Gatewaze's existing web tools.
 */
const TIER1_NATIVE_TOOL_MAPPINGS = new Set([
  // Anthropic native web_search → runner's web_search web tool.
  'web_search',
  // fetch_url MCP → runner's fetch_url tool.
  'fetch_url',
  // gatewaze_search → runner's gatewaze_search (Serper/DDG).
  'gatewaze_search',
]);

/**
 * Goose `builtin` extensions that v1 records as Tier-2 placeholders.
 * These are recognised so recipes parse cleanly; v2 may wire them up.
 */
const TIER2_RECOGNISED_BUILTINS = new Set([
  'memory',         // §4.10 — wired to ai_recipe_memory in the executor
  'chatrecall',
  'todo',
  'tom',
  // computercontroller is desktop/UI-coupled on local-Goose (browser
  // automation), but run-recipe-goose.ts's substituteComputercontroller
  // strips it on Gatewaze spawns and force-attaches the gatewaze-web-
  // tools MCP (gatewaze_search) in its place. Recognise it as Tier-2
  // here so recipes that declare it (the canonical pattern for
  // "this recipe needs web tools — handle however your runtime can")
  // parse cleanly. Without this, definitive recipes can't be written
  // to run on both local-Goose AND Gatewaze: local needs the
  // declaration, the parser refused it.
  'computercontroller',
]);

/**
 * Tier-3 desktop/UI-coupled Goose builtins. These are refused — they
 * need a Goose-desktop runtime the API server doesn't have.
 */
const TIER3_DESKTOP_BUILTINS = new Set([
  'autovisualiser',
  'peekaboo',
  'tutorial',
]);

/**
 * Tier-3 Goose platform extensions. These need filesystem / shell /
 * container environments v1 doesn't provide.
 */
const TIER3_PLATFORM_EXTENSIONS = new Set([
  'developer',
  'analyze',
  'apps',
  'summarize',
  'code_execution',
  'orchestrator',
  'extensionmanager',
]);

/**
 * Classify a recipe extension entry. Returns the tier and (when
 * Tier-3) a stable refusal-feature key + human-readable detail.
 */
export function classifyExtension(ext: ExtensionInput): TierClassification {
  const type = (ext.type ?? '').toLowerCase();
  const name = (ext.name ?? '').toLowerCase();

  // ── streamable_http — always Tier-1 ──────────────────────────────
  if (type === 'streamable_http') {
    return { tier: 1 };
  }

  // ── stdio — depends on operator allowlist ────────────────────────
  if (type === 'stdio') {
    const cmd = ext.cmd ?? '';
    const allow = ext.stdioAllowlist ?? [];
    if (cmd.length > 0 && allow.includes(cmd)) {
      return { tier: 2 };
    }
    return {
      tier: 3,
      refusalFeature: 'stdio-not-allowlisted',
      details: cmd
        ? `cmd '${cmd}' is not in the operator-controlled stdio allowlist`
        : 'stdio extension requires a `cmd:` field',
    };
  }

  // ── inline_python — refused (no sandbox in v1) ───────────────────
  if (type === 'inline_python') {
    return {
      tier: 3,
      refusalFeature: 'sandboxed-execution',
      details: 'inline_python requires a Python sandbox not available in v1',
    };
  }

  // ── frontend — refused (browser-coupled) ─────────────────────────
  if (type === 'frontend') {
    return {
      tier: 3,
      refusalFeature: 'frontend-extension',
      details: 'frontend extensions require a browser runtime not available server-side',
    };
  }

  // ── builtin ──────────────────────────────────────────────────────
  if (type === 'builtin') {
    if (TIER2_RECOGNISED_BUILTINS.has(name)) {
      return { tier: 2 };
    }
    if (TIER3_DESKTOP_BUILTINS.has(name)) {
      return {
        tier: 3,
        refusalFeature: 'desktop-extension',
        details: `builtin '${name}' is desktop/UI-coupled`,
      };
    }
    // Unknown builtin — Tier-3 by default. Better to fail loud than
    // silently accept and have the model call missing tools.
    return {
      tier: 3,
      refusalFeature: 'tier-3-extension',
      details: `unrecognised builtin extension '${name}'`,
    };
  }

  // ── platform ─────────────────────────────────────────────────────
  if (type === 'platform') {
    // summon is special — `load` is Tier-2 (read-only skill loading),
    // `delegate` is Tier-3 (model-driven branching per §4.6).
    if (name === 'summon') {
      const uses = (ext.uses ?? []).map((u) => u.toLowerCase());
      if (uses.includes('delegate')) {
        return {
          tier: 3,
          refusalFeature: 'model-driven-branching',
          details: 'summon.delegate violates DAG-determinism (§4.6); use activation_key for declarative branching',
        };
      }
      // load-only summon usage is Tier-2.
      return { tier: 2 };
    }
    if (TIER3_PLATFORM_EXTENSIONS.has(name)) {
      return {
        tier: 3,
        refusalFeature: 'tier-3-extension',
        details: `platform extension '${name}' requires filesystem/shell access not available in v1`,
      };
    }
    if (TIER2_RECOGNISED_BUILTINS.has(name)) {
      // chatrecall/todo/tom can appear under platform: too.
      return { tier: 2 };
    }
    return {
      tier: 3,
      refusalFeature: 'tier-3-extension',
      details: `unrecognised platform extension '${name}'`,
    };
  }

  // ── Anthropic-native tool declared bare (no type:) ───────────────
  if (TIER1_NATIVE_TOOL_MAPPINGS.has(name)) {
    return { tier: 1 };
  }

  // ── Default refusal ──────────────────────────────────────────────
  return {
    tier: 3,
    refusalFeature: 'tier-3-extension',
    details: `unknown extension type='${ext.type ?? ''}' name='${ext.name ?? ''}'`,
  };
}
