// @ts-nocheck — vitest types resolved at workspace install time
/**
 * The default importer must load the copilot's lazy entry specifier
 * (`@gatewaze-modules/editor-ai-copilot/admin/plugin`), not the old
 * `/admin` barrel that the platform boot-imports
 * (linuxfoundation/lfx-self-serve#3762).
 */
import { afterEach, expect, it, vi } from 'vitest';

const aiPlugin = { name: 'editor-ai-copilot' };
vi.mock('@gatewaze-modules/editor-ai-copilot/admin/plugin', () => ({ aiPlugin }));

import { _setCanvasAiPluginImporterForTests, loadCanvasAiPlugins } from '../load-canvas-ai-plugins.js';

afterEach(() => {
  _setCanvasAiPluginImporterForTests(null);
});

it('loads the plugin from the copilot lazy entry', async () => {
  _setCanvasAiPluginImporterForTests(null);
  await expect(loadCanvasAiPlugins()).resolves.toEqual([aiPlugin]);
});
