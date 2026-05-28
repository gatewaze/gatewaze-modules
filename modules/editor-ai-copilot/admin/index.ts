/**
 * Admin entrypoint — registers the AI Puck plugin into the shared
 * canvas-puck-plugin-registry. Both sites' PuckCanvasEditor and
 * newsletters' NewsletterPuckCanvas read from that registry, so
 * this single registration reaches both editors.
 *
 * Per spec-canvas-ai-copilot.md §3.8.
 *
 * The plugin reads host identity (hostKind/hostId/targetId) from the
 * shared `CanvasPluginHostContext` defined in sites. Host editors
 * provide that context unconditionally — they don't depend on this
 * (premium) module.
 */

import { registerCanvasPuckPlugin } from '@gatewaze-modules/sites/admin/components/canvas/puck/canvas-puck-plugin-registry.js';
import { aiPlugin } from './components/aiPlugin.js';

// Side-effect import — running this module registers the plugin.
registerCanvasPuckPlugin(aiPlugin);

export { aiPlugin };
