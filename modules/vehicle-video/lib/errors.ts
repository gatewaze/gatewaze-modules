/**
 * VehicleVideoError — a stable, structured error surfaced in the `error` jsonb
 * ({ code, phase, message, at }) and in API bodies. Spec §11.
 */

export type VehicleVideoErrorCode =
  | 'INVENTORY_FETCH_FAILED'
  | 'SCRAPE_BLOCKED_URL'
  | 'SCRAPE_NO_IMAGES'
  | 'SCRAPE_FETCH_FAILED'
  | 'STYLE_RECIPE_FAILED'
  | 'SCRIPT_RECIPE_FAILED'
  | 'CLIP_PROMPT_RECIPE_FAILED'
  | 'VEO_MODEL_UNAVAILABLE'
  | 'VEO_SUBMIT_FAILED'
  | 'VEO_POLL_TIMEOUT'
  | 'REGEN_LIMIT_REACHED'
  | 'COST_CEILING_EXCEEDED'
  | 'VOICEOVER_RECIPE_FAILED'
  | 'TTS_FAILED'
  | 'COMPOSE_FAILED'
  | 'STORAGE_FAILED'
  | 'GATE_CLOSED'
  | 'TOO_MANY_SHOTS'
  | 'SHOTS_NOT_ALL_APPROVED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'INTERNAL';

export type Phase =
  | 'inventory'
  | 'scrape'
  | 'style'
  | 'script'
  | 'clip'
  | 'finalize'
  | 'gate'
  | 'api';

export interface StructuredError {
  code: VehicleVideoErrorCode;
  phase: Phase;
  message: string;
  at: string;
}

export class VehicleVideoError extends Error {
  readonly code: VehicleVideoErrorCode;
  readonly phase: Phase;
  /** Suggested HTTP status when surfaced from an API route. */
  readonly httpStatus: number;

  constructor(code: VehicleVideoErrorCode, phase: Phase, message: string, httpStatus = 500) {
    super(message);
    this.name = 'VehicleVideoError';
    this.code = code;
    this.phase = phase;
    this.httpStatus = httpStatus;
  }

  toJSON(): StructuredError {
    return { code: this.code, phase: this.phase, message: this.message.slice(0, 1000), at: nowIso() };
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Build the `error` jsonb payload from any thrown value. */
export function toStructuredError(err: unknown, phase: Phase): StructuredError {
  if (err instanceof VehicleVideoError) return err.toJSON();
  return {
    code: 'INTERNAL',
    phase,
    message: String((err as Error)?.message ?? err).slice(0, 1000),
    at: nowIso(),
  };
}

/** Uniform API error envelope: { error: { code, message } } (§9). */
export function apiErrorBody(err: unknown): { error: { code: VehicleVideoErrorCode; message: string } } {
  if (err instanceof VehicleVideoError) {
    return { error: { code: err.code, message: err.message } };
  }
  return { error: { code: 'INTERNAL', message: 'Internal error' } };
}
