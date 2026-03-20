import type { GatewazeModule } from '@gatewaze/shared/modules';

const module: GatewazeModule = {
  id: 'ad-conversions',
  name: 'Ad Conversions',
  description:
    'Ad platform conversion tracking for Meta (Facebook/Instagram) and Reddit campaigns',
  version: '1.0.0',
  type: 'integration',
  group: 'integration',
  features: ['ad-conversions', 'ad-conversions.meta', 'ad-conversions.reddit'],
  edgeFunctions: [
    'integrations-send-conversion',
    'integrations-send-meta-conversion',
    'integrations-send-reddit-conversion',
  ],
};

export default module;
