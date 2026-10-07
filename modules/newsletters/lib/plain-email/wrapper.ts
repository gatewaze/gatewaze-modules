/**
 * The built-in "Plain email" wrapper.
 *
 * Renders an edition or broadcast the way a message typed into Gmail arrives:
 * no header, no centred column, no colours or fonts of its own, and an
 * unsubscribe line as ordinary left-aligned text under the message. The
 * receiving client supplies the font, the text colour and the background, so
 * the email follows the reader's light/dark setting like any personal email.
 *
 * Shared by newsletters (a publication's built-in wrapper choice) and
 * broadcasts (the `plain` template). Lives in lib/ so both the admin bundle
 * and server code can import it without React.
 *
 * The SHELL directive is what EditionEmail keys on: a wrapper that carries it
 * is rendered without the standard 600px Container and font stack, and with
 * the colour-scheme metas that let Apple Mail / iOS follow dark mode.
 */

/** Directive comment a wrapper carries to opt out of the standard email shell. */
export const PLAIN_SHELL_DIRECTIVE = '<!-- SHELL: plain -->';

/** True when the wrapper asks for the plain shell. */
export function isPlainShell(wrapperTemplate: string | null | undefined): boolean {
  return typeof wrapperTemplate === 'string' && /<!--\s*SHELL:\s*plain\s*-->/i.test(wrapperTemplate);
}

/**
 * The wrapper itself (declarative template syntax, see parse-template.ts).
 * Only `edition.unsubscribe_url` / `edition.manage_subscriptions_url` are
 * used; on a send render they carry the per-recipient tokens, on a web or
 * canvas render they are empty and the `if` guard drops the line.
 *
 * Deliberately no font-family, font-size, colour or alignment anywhere: the
 * point is that nothing here overrides what the reader's client would do with
 * a hand-written message.
 */
export const PLAIN_EMAIL_WRAPPER = `${PLAIN_SHELL_DIRECTIVE}
<!-- SCHEMA: {
  "edition": {
    "unsubscribe_url":          {"type": "text", "label": "Unsubscribe URL"},
    "manage_subscriptions_url": {"type": "text", "label": "Manage subscriptions URL"}
  }
} -->
<slot name="body" />
<div if="edition.unsubscribe_url" style="margin: 24px 0 0">
  <a href="{{edition.unsubscribe_url}}">Unsubscribe</a>
  &middot;
  <a href="{{edition.manage_subscriptions_url}}">Manage your email preferences</a>
</div>
`;

/** Key stored in `newsletters_template_collections.metadata.builtin_wrapper`. */
export const BUILTIN_WRAPPER_META_KEY = 'builtin_wrapper';

/** The built-in wrappers a publication can choose instead of its repo's `wrappers/default.html`. */
export const BUILTIN_WRAPPERS = {
  plain: { label: 'Plain email', description: 'Reads like a message typed in Gmail: no header, no column, the reader’s own font and colours, unsubscribe as plain text.', html: PLAIN_EMAIL_WRAPPER },
} as const;

export type BuiltinWrapperKey = keyof typeof BUILTIN_WRAPPERS;

export function isBuiltinWrapperKey(v: unknown): v is BuiltinWrapperKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_WRAPPERS, v);
}

/**
 * Which wrapper a publication renders with: a built-in one named in its
 * metadata, or (null) the repo wrapper the caller fetches from
 * `templates_wrappers`. Keeps the precedence rule in one place.
 */
export function builtinWrapperFor(metadata: Record<string, unknown> | null | undefined): string | null {
  const key = metadata?.[BUILTIN_WRAPPER_META_KEY];
  return isBuiltinWrapperKey(key) ? BUILTIN_WRAPPERS[key].html : null;
}
