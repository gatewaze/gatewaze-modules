/**
 * The approved spec, as it goes into an agent's prompt.
 *
 * The implement and architecture phases used to inline `content.slice(0,
 * 20000)` and say nothing. On staging 47 of 144 specs were longer than that,
 * the longest 54,952 characters, so a third of all runs handed the agent a
 * spec cut off mid-sentence. Sometimes the cut landed somewhere harmless.
 * When it landed inside the section the change depended on, the agent did the
 * right thing and refused to build from half a spec, then asked a question
 * nobody was there to answer in an unattended run, and the phase ended with
 * "implement produced no changes". Two runs failed exactly that way, both cut
 * inside §5.3.
 *
 * The cap stays, as a guard against a pathological artifact, but at a size no
 * real spec has come near. The real fix is that a cut is now SAID: the agent
 * is told the spec continues and must not treat the end of the text as the
 * end of the requirements. A silent cut is what turned a size limit into a
 * wrong conclusion.
 */

/** Comfortably above the largest spec seen (54,952 characters), about 40k tokens. */
export const SPEC_PROMPT_LIMIT = 150_000;

export function specForPrompt(content: string | null | undefined, limit = SPEC_PROMPT_LIMIT): string {
  const text = String(content ?? '');
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return (
    text.slice(0, limit)
    + '\n\n[SPEC TRUNCATED. The approved spec continues for another '
    + `${omitted.toLocaleString('en-GB')} characters that are not shown here. `
    + 'Do not treat this point as the end of the requirements, and do not guess at '
    + 'what follows. Implement only what is fully specified above, and say in your '
    + 'final message that the spec was too long to read in full.]'
  );
}
