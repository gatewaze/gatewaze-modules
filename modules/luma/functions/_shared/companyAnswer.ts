/**
 * Luma's "company" question type collects two fields, company and job title,
 * and the registration notification email renders them as one line:
 *
 *   What company do you work for? Phonely - CEO
 *
 * There is no separate job-title line in the email, so the only way to get
 * both values is to split that answer. The first " - " is the boundary; a
 * title that itself contains " - " stays whole ("Sinch - Sr Sales Manager -
 * New Business" is company "Sinch", title "Sr Sales Manager - New Business").
 *
 * Pure: no Deno or Supabase imports, so it is unit-testable from the host.
 */
const MAX_LEN = 200

/** Inbound email text: drop control characters and cap the length. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  // Cut on code points, not UTF-16 units, so the cap cannot leave half a character.
  return Array.from(t).slice(0, MAX_LEN).join('').trim()
}

export function splitCompanyAnswer(answer: unknown): { company?: string; jobTitle?: string } {
  if (typeof answer !== 'string') return {}
  const s = clean(answer)
  if (!s) return {}
  const idx = s.indexOf(' - ')
  if (idx <= 0) return { company: s }
  const company = s.slice(0, idx).trim()
  const jobTitle = s.slice(idx + 3).trim()
  return {
    ...(company ? { company } : {}),
    ...(jobTitle ? { jobTitle } : {}),
  }
}
