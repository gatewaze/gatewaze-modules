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
