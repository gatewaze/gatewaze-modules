/**
 * Resolve the system prompt + kickoff message for an ai_use_case.
 *
 * Per migration 008_ai_use_cases_skill_ref:
 *   - If `skill_source_id` + `skill_path` are set AND a matching ai_skills
 *     row exists, the skill's `body` becomes the system prompt. This is
 *     the path that lets operators version-control prompts via a git repo.
 *   - Otherwise the inline `system_prompt` column is used (operator-edited
 *     directly in the admin UI).
 *   - `kickoff_message` is the initial user turn for autopilot triggers
 *     (daily-briefing "Run research", future "Run on all tabs"). It is
 *     never sourced from a skill — kickoffs are intentionally short.
 *
 * Callers should treat both fields as "may be empty string" — that's the
 * documented "no prompt configured" state, not an error.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supabase = { from(table: string): any };

export interface ReferenceImage {
  mimeType: string;
  /** Base64-encoded image bytes. */
  base64: string;
}

export interface UseCasePrompt {
  systemPrompt: string;
  kickoffMessage: string;
  /**
   * Reference images carried by the bound skill (e.g. style anchors for
   * image-gen use cases). Empty array when the use case has no skill
   * bound, the skill has no reference image, or the skill row is
   * missing. Consumers pass these to image generators as conditioning.
   */
  referenceImages: ReferenceImage[];
  /** Which path produced systemPrompt — useful for logging. */
  source: 'skill' | 'inline' | 'empty';
}

export async function resolveUseCasePrompt(
  supabase: Supabase,
  useCaseId: string,
): Promise<UseCasePrompt> {
  const uc = await supabase
    .from('ai_use_cases')
    .select('system_prompt, kickoff_message, skill_source_id, skill_path')
    .eq('id', useCaseId)
    .maybeSingle();
  if (uc.error || !uc.data) {
    return { systemPrompt: '', kickoffMessage: '', referenceImages: [], source: 'empty' };
  }
  const row = uc.data as {
    system_prompt: string | null;
    kickoff_message: string | null;
    skill_source_id: string | null;
    skill_path: string | null;
  };
  const kickoffMessage = row.kickoff_message ?? '';

  if (row.skill_source_id && row.skill_path) {
    const skill = await supabase
      .from('ai_skills')
      .select('body, reference_image_bytes, reference_image_mime')
      .eq('source_id', row.skill_source_id)
      .eq('path', row.skill_path)
      .maybeSingle();
    if (!skill.error && skill.data) {
      const data = skill.data as {
        body?: unknown;
        reference_image_bytes?: unknown;
        reference_image_mime?: unknown;
      };
      const referenceImages = extractReferenceImages(
        data.reference_image_bytes,
        data.reference_image_mime,
      );
      if (typeof data.body === 'string' && data.body.trim().length > 0) {
        return { systemPrompt: data.body, kickoffMessage, referenceImages, source: 'skill' };
      }
    }
    // Skill bound but missing/empty/inaccessible — fall through to inline.
  }

  const inline = row.system_prompt ?? '';
  return {
    systemPrompt: inline,
    kickoffMessage,
    referenceImages: [],
    source: inline.length > 0 ? 'inline' : 'empty',
  };
}

/**
 * The bytea column round-trips through postgrest as either a hex string
 * (`\x<hex>`) or a base64 string depending on driver settings. Normalise
 * to base64 for the Gemini inline payload.
 */
function extractReferenceImages(
  rawBytes: unknown,
  rawMime: unknown,
): ReferenceImage[] {
  if (typeof rawMime !== 'string' || rawMime.length === 0) return [];
  if (rawBytes == null) return [];

  let base64: string | null = null;
  if (typeof rawBytes === 'string') {
    if (rawBytes.startsWith('\\x')) {
      // Hex-encoded bytea string from PostgREST.
      const hex = rawBytes.slice(2);
      if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0) {
        base64 = Buffer.from(hex, 'hex').toString('base64');
      }
    } else if (/^[A-Za-z0-9+/=]+$/.test(rawBytes)) {
      // Already base64.
      base64 = rawBytes;
    }
  } else if (rawBytes instanceof Uint8Array) {
    base64 = Buffer.from(rawBytes).toString('base64');
  }

  if (!base64 || base64.length === 0) return [];
  return [{ mimeType: rawMime, base64 }];
}
