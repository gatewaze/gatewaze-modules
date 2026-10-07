/**
 * Which email shell the blocks are rendering inside.
 *
 * `default` is the standard 600px centred column with the platform font
 * stack; blocks style themselves fully (colours, sizes, alignment).
 * `plain` is the built-in plain-email wrapper (lib/plain-email): the shell
 * sets no font, colour or width, and blocks drop their own typography so the
 * output reads like a hand-written message in whatever the reader's client
 * uses, light or dark.
 *
 * A module-level flag rather than React context, on purpose: blocks render
 * in two trees — EditionEmail (export / send) and the Puck canvas (editor
 * preview, where there is no EditionEmail above them) — and a context would
 * need a Provider in each, plus one React instance across the module and
 * host bundles. Renders are synchronous, so whoever owns the tree sets the
 * shell before rendering and blocks read it as they render. Same pattern as
 * the embed's `setEmbeddedMode`.
 */
export type EmailShell = 'default' | 'plain';

let current: EmailShell = 'default';

/** Set by EditionEmail (per render) and by the canvas (when its wrapper resolves). */
export function setEmailShell(shell: EmailShell): void {
  current = shell;
}

/** Read by blocks while rendering. */
export function getEmailShell(): EmailShell {
  return current;
}
