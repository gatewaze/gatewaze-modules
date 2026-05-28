import type { GatewazeModule } from '@gatewaze/shared';

const beehiivOutputModule: GatewazeModule = {
  id: 'newsletters-output-beehiiv',
  group: 'content',
  type: 'integration',
  visibility: 'public',
  name: 'Newsletter Output: Beehiiv',
  description: 'Generates simplified semantic HTML for pasting into Beehiiv rich text editor. Excludes header, footer, and promotional blocks.',
  version: '1.0.0',
  features: ['newsletters.output.beehiiv'],
  dependencies: ['newsletters'],
  migrations: [],
  configSchema: {},

  onInstall: async () => {
    console.log('[newsletters-output-beehiiv] Module installed');
  },
  onEnable: async () => {
    console.log('[newsletters-output-beehiiv] Module enabled');
  },
  onDisable: async () => {
    console.log('[newsletters-output-beehiiv] Module disabled');
  },
};

export default beehiivOutputModule;
