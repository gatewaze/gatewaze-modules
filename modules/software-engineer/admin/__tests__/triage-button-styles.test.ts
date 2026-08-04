import { describe, it, expect } from 'vitest';
import { TRIAGE_SEND_BUTTON_CLASS } from '../components/triageButtonStyles';

// Issue #31 — the copilot "Send" button rendered as an unstyled grey box (tall/narrow) inside the
// "Report feedback" widget, because that widget mounts in a detached root OUTSIDE the app's <Theme>
// and the old Radix <Button> drew its background/geometry from theme CSS custom properties that
// aren't in scope there. The fix swaps in a native Tailwind <button>. The invariant that keeps the
// bug from returning: the class string must be self-contained — no dependency on `var(--…)` theme
// tokens. The component tree can't render under this module's `node` vitest env (no jsdom, and
// heroicons is a host-provided peer), so we pin the styling contract via the pure class string.
describe('TRIAGE_SEND_BUTTON_CLASS', () => {
  it('carries no theme-scoped CSS variables — the root cause of the detached-root regression', () => {
    expect(TRIAGE_SEND_BUTTON_CLASS).not.toContain('var(--');
  });

  it('sets an explicit background and text colour so it is visible without a <Theme>', () => {
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('bg-blue-600');
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('text-white');
  });

  it('centres its icon and holds a fixed footprint (no collapse to a tall/narrow box)', () => {
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('flex');
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('items-center');
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('justify-center');
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('shrink-0');
  });

  it('dims and disables pointer interaction when disabled', () => {
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('disabled:opacity-50');
    expect(TRIAGE_SEND_BUTTON_CLASS).toContain('disabled:pointer-events-none');
  });
});
