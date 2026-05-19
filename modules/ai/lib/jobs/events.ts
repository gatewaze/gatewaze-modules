/**
 * StreamEvent DTOs + helpers for the Redis Streams SSE bridge.
 *
 * Workers XADD entries with two hash fields:
 *   type    — the event type discriminator
 *   payload — JSON.stringify of the rest of the event body
 *
 * The bridge JSON.parses payload and yields `{ type, ts, ...payload }` to
 * SSE consumers. So clients see one flat object per SSE message.
 *
 * Spec: spec-ai-job-runner §5.4.
 */

export type StreamEvent =
  | { type: 'run.start'; ts: number; recipeId: string }
  | { type: 'step.start'; ts: number; step_index: number; step_label?: string; step_id?: string }
  | { type: 'step.delta'; ts: number; step_index: number; delta: string }
  | {
      type: 'step.complete';
      ts: number;
      step_index: number;
      structured: Record<string, unknown> | null;
      cost_micro_usd: number;
    }
  | {
      type: 'tool_call';
      ts: number;
      step_index: number;
      tool_name: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      ts: number;
      step_index: number;
      tool_name: string;
      ok: boolean;
      result: unknown;
    }
  | { type: 'token'; ts: number; delta: string }
  | {
      type: 'assistant.complete';
      ts: number;
      messageId: string;
      cost_micro_usd: number;
      tokens_in: number;
      tokens_out: number;
    }
  | {
      type: 'run.complete';
      ts: number;
      final_output: unknown;
      total_cost_micro_usd: number;
    }
  | { type: 'run.failed'; ts: number; error: { code: string; message: string } }
  | { type: 'run.cancelled'; ts: number; reason: 'user' | 'timeout' | 'admin' }
  | { type: 'close'; ts: number };

export type StreamEventType = StreamEvent['type'];

/**
 * Recursive redaction of sensitive fields. Spec §8.4 — match keys
 * /(key|secret|token|password|authorization)/i (case-insensitive), replace
 * the value with '<redacted>'. Walks nested objects + arrays.
 */
const SENSITIVE_KEY_RE = /(key|secret|token|password|authorization)/i;

export function redactSensitive<T>(value: T): T {
  return walk(value) as T;

  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEY_RE.test(k)) {
          out[k] = '<redacted>';
        } else {
          out[k] = walk(child);
        }
      }
      return out;
    }
    return v;
  }
}

/**
 * Convert a StreamEvent into the two hash fields the worker writes via
 * XADD: { type, payload }. Caller adds `ts` for free.
 */
export function eventToHashFields(event: StreamEvent): Record<string, string> {
  const { type, ts: _ts, ...rest } = event;
  return {
    type,
    payload: JSON.stringify(redactSensitive(rest)),
  };
}

/**
 * Reverse of eventToHashFields — turn a Redis XREAD reply's key-value
 * pairs back into a typed event. The bridge calls this once per entry.
 *
 * `kv` is a flat array like ['type', 'token', 'payload', '{"delta":"hi"}'].
 * Tolerates missing/garbage payload (returns minimal event with no extras).
 */
export function hashFieldsToEvent(
  ts: number,
  kv: string[] | Record<string, string>,
): StreamEvent | null {
  const obj = Array.isArray(kv) ? kvArrayToObj(kv) : kv;
  if (!obj.type) return null;
  let parsed: Record<string, unknown> = {};
  if (obj.payload) {
    try {
      const j = JSON.parse(obj.payload);
      if (j && typeof j === 'object' && !Array.isArray(j)) parsed = j as Record<string, unknown>;
    } catch {
      // Treat unparseable payload as empty — better to emit a minimal
      // event than to drop the entry entirely.
    }
  }
  return { type: obj.type as StreamEventType, ts, ...parsed } as StreamEvent;
}

function kvArrayToObj(kv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < kv.length; i += 2) {
    out[kv[i]!] = kv[i + 1]!;
  }
  return out;
}
