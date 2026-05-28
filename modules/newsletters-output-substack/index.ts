import type { GatewazeModule } from '@gatewaze/shared';

const substackOutputModule: GatewazeModule = {
  id: 'newsletters-output-substack',
  group: 'content',
  type: 'integration',
  visibility: 'public',
  name: 'Newsletter Output: Substack',
  description: 'Generates simplified semantic HTML for pasting into Substack rich text editor. Excludes header, footer, and promotional blocks.',
  version: '1.0.0',
  features: ['newsletters.output.substack'],
  dependencies: ['newsletters'],
  migrations: [],
  configSchema: {},

  onInstall: async () => {
    console.log('[newsletters-output-substack] Module installed');
  },
  onEnable: async () => {
    console.log('[newsletters-output-substack] Module enabled');
  },
  onDisable: async () => {
    console.log('[newsletters-output-substack] Module disabled');
  },
};

export default substackOutputModule;
