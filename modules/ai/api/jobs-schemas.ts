/**
 * Zod schemas for /admin/jobs/* + SSE endpoints.
 *
 * Per spec-ai-job-runner §8.1.1 — every new endpoint validates inputs
 * via zod before persistence. Unknown fields are rejected (strict()).
 */

// zod is a peer/dep of the host platform — at module dev-time it may
// not be installed, so the import is suppressed for the type check
// of this standalone package.
// @ts-expect-error -- zod resolved at host install time
import { z } from 'zod';

const JOB_ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_:.-]+$/, 'job id must match /^[A-Za-z0-9_:.-]+$/');

const UUID = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'must be a UUID',
  );

const STATUS_VALUES = ['active', 'waiting', 'delayed', 'failed', 'completed'] as const;

export const ListJobsQuerySchema = z
  .object({
    // Comma-separated list — parsed into the array post-validation.
    status: z.string().optional(),
    type: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const JobIdParamSchema = z.object({ id: JOB_ID });
export const UuidParamSchema = z.object({ id: UUID });

export const StreamOffsetQuerySchema = z
  .object({
    offset: z
      .string()
      .regex(/^(\$|0|\d+-\d+)$/, 'offset must be $, 0, or <ms>-<seq>')
      .optional(),
  })
  .strict();

export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

/**
 * Validate query string params. Returns either the parsed object or a
 * `[code, message]` tuple suitable for the standard error envelope.
 */
export function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; code: string; message: string } {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    code: 'invalid_input',
    message: first ? `${first.path.join('.')}: ${first.message}` : 'invalid input',
  };
}

export function parseStatusList(s: string | undefined): (typeof STATUS_VALUES)[number][] {
  if (!s || s.length === 0) return ['active', 'waiting', 'delayed', 'failed'];
  const out: (typeof STATUS_VALUES)[number][] = [];
  for (const part of s.split(',').map((x) => x.trim())) {
    if ((STATUS_VALUES as readonly string[]).includes(part)) {
      out.push(part as (typeof STATUS_VALUES)[number]);
    }
  }
  return out.length > 0 ? out : ['active', 'waiting'];
}
