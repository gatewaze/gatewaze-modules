import type { GatewazeModule } from '@gatewaze/shared';

const emailBotDetectorSignalsModule: GatewazeModule = {
  id: 'email-bot-detector-signals',
  group: 'communications',
  type: 'feature',
  visibility: 'public',
  name: 'Email Bot Detector: Signal-Based',
  description: 'Heuristic signal-based bot detection for email interactions. Identifies Apple MPP, corporate scanners, and link prefetchers using timing, user-agent, IP, and behavioral signals.',
  version: '1.0.0',
  features: ['email-bot-detector-signals'],
  dependencies: ['bulk-emailing'],
  migrations: [],
  edgeFunctions: [],
  // Copy detector.ts into the bulk-emailing edge functions'
  // _shared/detectors/signals.ts, where `bot-detector-registry.ts` imports
  // from via `import('./detectors/${detectorName}.ts')`. Without this entry
  // the dynamic import 503s and getBotDetector() silently returns null —
  // every webhook event then defaults to human_confidence=1.0 with no
  // detection_source row written, so the admin edition view shows only the
  // frozen Customer.io baseline and signals-v1 never appears. (Found on
  // AAIF prod 2026-06-19: zero email_event_classifications rows ever.)
  // Requires the matching deploy-edge-functions.ts change that supports
  // `subdir/file` destinations (commit shipping in same release).
  functionFiles: ['detector.ts:detectors/signals.ts'],
  configSchema: {},

  onInstall: async () => {
    console.log('[email-bot-detector-signals] Detector installed');
  },
  onEnable: async () => {
    console.log('[email-bot-detector-signals] Detector enabled');
  },
  onDisable: async () => {
    console.log('[email-bot-detector-signals] Detector disabled');
  },
};

export default emailBotDetectorSignalsModule;
