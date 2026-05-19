/**
 * `builtin: memory` tool surface — per spec-ai-workflows-and-skill-
 * interop.md §4.10.
 *
 * Three tool functions exposed to every step in a recipe that
 * declares `extensions: [{ type: builtin, name: memory }]`:
 *
 *   memory.store(key, value)   → { ok: true } | { ok: false, error }
 *   memory.retrieve(key)       → { value: any | null }
 *   memory.list_keys()         → { keys: string[] }
 *
 * Constraints (enforced here, not by the DB CHECK alone):
 *   - Key regex: ^[a-zA-Z_][a-zA-Z0-9_]{0,127}$
 *   - Value: JSON-encoded; ≤64 KiB per value.
 *   - Total keys per run: ≤100 (writes beyond return limit_reached).
 *
 * Scope: per-run. The DB has ON DELETE CASCADE from ai_recipe_runs,
 * so cancelling/deleting a run wipes its memory. No cross-run state
 * — that's a v2 concern (§14).
 *
 * Threading: the executor builds a fresh `MemoryTool` per recipe run
 * and passes it to runChat as a tool-resolver. The implementation is
 * deliberately not a class — a small closure wins on testability +
 * cuts a layer of indirection.
 */

const KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KEYS_PER_RUN = 100;

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface MemoryToolHandle {
  store(key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
  retrieve(key: string): Promise<{ value: unknown | null }>;
  list_keys(): Promise<{ keys: string[] }>;
}

/**
 * Build a memory handle bound to a single recipe run. The handle
 * captures `runId` so concurrent runs can't see each other's keys.
 */
export function createMemoryTool(supabase: SupabaseLike, runId: string): MemoryToolHandle {
  return {
    async store(key, value) {
      if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
        return { ok: false, error: 'invalid_key' };
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(value);
      } catch (err) {
        return {
          ok: false,
          error: `value_not_serialisable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (Buffer.byteLength(encoded, 'utf-8') > MAX_VALUE_BYTES) {
        return { ok: false, error: 'value_too_large' };
      }

      // Atomic limit check + insert. PostgREST doesn't have a
      // transaction primitive; we do count → upsert in two queries
      // with idempotent semantics — concurrent writes on different
      // keys past the cap will both succeed at N+1 = MAX+1, which is
      // an acceptable boundary slop (per-run isolation makes
      // contention rare in practice).
      const countRes = await supabase
        .from('ai_recipe_memory')
        .select('key', { count: 'exact', head: true })
        .eq('recipe_run_id', runId);
      const existing = (countRes?.count as number | null) ?? 0;
      // Check whether THIS key already exists — overwrites don't
      // count against the cap. PostgREST doesn't expose a row+null
      // pattern; do a maybeSingle on (run_id, key).
      const exists = await supabase
        .from('ai_recipe_memory')
        .select('key')
        .eq('recipe_run_id', runId)
        .eq('key', key)
        .maybeSingle();
      const isOverwrite = Boolean(exists?.data);
      if (!isOverwrite && existing >= MAX_KEYS_PER_RUN) {
        return { ok: false, error: 'limit_reached' };
      }

      const ups = await supabase
        .from('ai_recipe_memory')
        .upsert(
          {
            recipe_run_id: runId,
            key,
            value: JSON.parse(encoded),
            written_at: new Date().toISOString(),
          },
          { onConflict: 'recipe_run_id,key' },
        )
        .select('key')
        .maybeSingle();
      if (ups?.error) {
        return { ok: false, error: String(ups.error.message ?? ups.error) };
      }
      return { ok: true };
    },

    async retrieve(key) {
      if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
        return { value: null };
      }
      const res = await supabase
        .from('ai_recipe_memory')
        .select('value')
        .eq('recipe_run_id', runId)
        .eq('key', key)
        .maybeSingle();
      return { value: res?.data?.value ?? null };
    },

    async list_keys() {
      const res = await supabase
        .from('ai_recipe_memory')
        .select('key')
        .eq('recipe_run_id', runId);
      const rows = (res?.data as Array<{ key: string }> | null) ?? [];
      return { keys: rows.map((r) => r.key).sort() };
    },
  };
}

/**
 * JSON-schema descriptors for the three memory functions. Provider
 * clients (Anthropic/OpenAI/Gemini) take these in their tool-use
 * blocks. Names are dot-separated mirroring Goose's surface so
 * recipes port without renaming tool calls.
 */
export const MEMORY_TOOL_SCHEMAS = [
  {
    name: 'memory.store',
    description: 'Persist a value under a key in this recipe run\'s memory store. Keys are scoped to this run only.',
    input_schema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]{0,127}$' },
        value: {},
      },
    },
  },
  {
    name: 'memory.retrieve',
    description: 'Read a previously-stored value from this run\'s memory. Returns null when the key does not exist.',
    input_schema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]{0,127}$' },
      },
    },
  },
  {
    name: 'memory.list_keys',
    description: 'List all keys currently stored in this run\'s memory.',
    input_schema: { type: 'object', properties: {} },
  },
] as const;
