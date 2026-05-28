/**
 * Wrap fetched page text in clearly-delimited tags. Spec §6.5.
 *
 * Prompt-injection mitigation: even after HTML stripping, extracted
 * text can contain hostile instructions ("ignore your previous
 * instructions and …"). Wrapping in `<fetched_content url="…">…
 * </fetched_content>` plus a system-prompt reinforcement tells the
 * model that anything inside the tags is DATA, not INSTRUCTIONS.
 *
 * The tags are not real XML — they're a token-cheap delimiter the
 * model recognises. We escape the url attribute to prevent the
 * model getting confused by adversarial URLs containing `"`.
 */

export function wrapAsFetchedContent(url: string, text: string): string {
  const safeUrl = url.replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<fetched_content url="${safeUrl}">\n${text}\n</fetched_content>`;
}
