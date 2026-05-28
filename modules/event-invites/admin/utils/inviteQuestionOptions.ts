/**
 * Question option normalization.
 *
 * Options on `invite_questions.options` are stored as a jsonb array. The
 * column originally held an array of plain strings; we now also support an
 * array of `{ label, description? }` objects so that admins can write rich
 * descriptions per option (e.g. menu items with a heading and a body).
 *
 * These helpers normalize both shapes into a uniform object form and
 * provide the answer value (which is always the option's label string).
 */

export interface NormalizedOption {
  label: string;
  /** Optional rich-HTML description shown beneath the label. */
  description?: string;
}

/** Read a single option from storage and return a normalized form. */
export function normalizeOption(raw: unknown): NormalizedOption {
  if (typeof raw === 'string') return { label: raw };
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    return {
      label: typeof r.label === 'string' ? r.label : '',
      description: typeof r.description === 'string' && r.description.trim() ? r.description : undefined,
    };
  }
  return { label: '' };
}

/** Normalize an array of options into the object form. */
export function normalizeOptions(options: unknown): NormalizedOption[] {
  if (!Array.isArray(options)) return [];
  return options.map(normalizeOption).filter(o => o.label !== '');
}

/**
 * The answer value sent to the server is always the option's `label`
 * string — the description is purely UI metadata.
 */
export function optionValue(o: NormalizedOption): string {
  return o.label;
}
