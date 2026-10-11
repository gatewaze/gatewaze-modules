/**
 * Test-time stub for the host admin app's `@/components/ui` barrel. The
 * real components live in gatewaze/packages/admin and are only resolvable
 * when this module is bundled into that app via the module registry (see
 * `.claude/rules/module-registry.md`). BroadcastsTable.test.tsx only needs
 * something that renders its children/text so column content is queryable.
 */
import type { ReactNode } from 'react';

export function Badge({ children }: { children?: ReactNode }) {
  return <span>{children}</span>;
}

export function Button({ children, onClick, disabled }: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
