/**
 * Host-kind registry. Consumer modules call registerHostMediaConsumer()
 * during their onEnable() lifecycle hook (or eagerly at module-load
 * time in the api process). The host-media API + admin tab read from
 * here at request time to know which features are enabled per kind.
 *
 * Per spec-host-media-module §3.2.
 */

import type { HostMediaConsumer } from '@gatewaze/shared';

const registry = new Map<string, HostMediaConsumer>();

export function registerHostMediaConsumer(consumer: HostMediaConsumer): void {
  registry.set(consumer.hostKind, consumer);
}

export function getHostMediaConsumer(hostKind: string): HostMediaConsumer | undefined {
  return registry.get(hostKind);
}

export function isKnownHostKind(hostKind: string): boolean {
  return registry.has(hostKind);
}

export function listHostMediaConsumers(): HostMediaConsumer[] {
  return Array.from(registry.values());
}

/**
 * Test-only — clears the registry between vitest tests.
 */
export function _resetRegistryForTests(): void {
  registry.clear();
}
