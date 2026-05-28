/**
 * Cross-module HostAdapter registry. Sites + newsletters each export a
 * HostAdapter and this module registers them into the registry at
 * module-init time. The generate endpoint dispatches by host_kind.
 */

import type { HostAdapter, HostKind } from './types.js';

const adapters = new Map<HostKind, HostAdapter>();

export function registerHostAdapter(kind: HostKind, adapter: HostAdapter): void {
  adapters.set(kind, adapter);
}

export function getHostAdapter(kind: HostKind): HostAdapter | undefined {
  return adapters.get(kind);
}

export function listRegisteredHostKinds(): ReadonlyArray<HostKind> {
  return Array.from(adapters.keys());
}

/** Test hook. */
export function _resetHostAdaptersForTests(): void {
  adapters.clear();
}
