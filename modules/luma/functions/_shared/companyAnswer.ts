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
export function splitCompanyAnswer(answer: unknown): { company?: string; jobTitle?: string } {
  if (typeof answer !== 'string') return {}
  const s = answer.trim()
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
