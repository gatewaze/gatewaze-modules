/**
 * Send-button styling for <TriageCopilot> (issue #31) — a theme-independent class string.
 *
 * The copilot's "Send" control was a Radix Themes <Button> (`@/components/ui`), which draws its
 * background, radius and sizing from CSS custom properties (`--accent-9`, `--radius-*`, …) scoped to
 * the app's <Theme> provider. But the "Report feedback" widget self-mounts into a DETACHED React
 * root on document.body (admin/index.ts), OUTSIDE that <Theme>. With no theme vars in scope the
 * Radix button renders unstyled — a grey box with collapsed (tall, narrow) geometry.
 *
 * We can't wrap the detached root in <Theme> — importing `@radix-ui/themes` inside a module file
 * duplicates the Radix singleton and crashes `useThemeContext` (every repo CLAUDE.md forbids it).
 * So the Send button uses a native Tailwind <button> whose styling depends only on utility classes,
 * matching the widget's own primary "Create issue" button (bg-blue-600 / white text). Keeping the
 * class string in a plain `.ts` module lets the theme-independence invariant be unit-tested under
 * vitest's `node` environment without heroicons/jsdom in the module's dependency graph (same shape
 * as projectAvatarUtils.ts from issue #27).
 */

/**
 * Utility classes for the copilot Send button. Mirrors the "Create issue" primary button in
 * ReportFeedbackWidget (`bg-blue-600 … text-white`) and adds flex-centering + a fixed square-ish
 * footprint so the icon-only control keeps its geometry regardless of any surrounding <Theme>.
 */
export const TRIAGE_SEND_BUTTON_CLASS =
  'flex shrink-0 items-center justify-center rounded-md bg-blue-600 px-3 py-2 text-white ' +
  'hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ' +
  'focus-visible:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none';
