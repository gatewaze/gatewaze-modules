/**
 * Test-only stub for the admin app's `@/components/ui` barrel.
 *
 * The puck/ field components import real UI primitives (RichTextEditor,
 * Modal, Button) from the admin app via `@/components/ui`. Those don't
 * resolve in the sites module's vitest run because `@/` is an admin-
 * only Vite alias. This stub provides minimal shims so tests that
 * touch the field index can load — without dragging the entire admin
 * UI library into the node test sandbox.
 *
 * Production builds resolve `@/components/ui` to the real admin
 * implementation; this stub is wired in via vitest.config.ts alias
 * and never ships.
 */
export const RichTextEditor = () => null;
// `@/components/ui/RichTextEditor` is imported as a default export in
// the live source. The stub satisfies both shapes (named + default) so
// either import style resolves cleanly under vitest.
export default RichTextEditor;
export const Modal = () => null;
export const Button = () => null;
export const Input = () => null;
export const Card = () => null;
