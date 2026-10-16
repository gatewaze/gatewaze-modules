// @ts-nocheck — vitest types resolved at workspace install time
/**
 * The copilot Puck plugin loads on demand (linuxfoundation/lfx-self-serve#3762).
 * These tests pin the loader's contract: one import shared by every
 * editor mount, a stable array once loaded, and a quiet empty result
 * when the copilot module is missing from the build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _setCanvasAiPluginImporterForTests,
  getLoadedCanvasAiPlugins,
  loadCanvasAiPlugins,
} from '../load-canvas-ai-plugins.js';

const aiPlugin = { name: 'editor-ai-copilot' };

afterEach(() => {
  _setCanvasAiPluginImporterForTests(null);
});

describe('loadCanvasAiPlugins', () => {
  it('does nothing until an editor asks for the plugin', () => {
    const importer = vi.fn(async () => ({ aiPlugin }));
    _setCanvasAiPluginImporterForTests(importer);
    expect(importer).not.toHaveBeenCalled();
    expect(getLoadedCanvasAiPlugins()).toBeNull();
  });

  it('returns the copilot plugin once loaded', async () => {
    _setCanvasAiPluginImporterForTests(async () => ({ aiPlugin }));
    await expect(loadCanvasAiPlugins()).resolves.toEqual([aiPlugin]);
    expect(getLoadedCanvasAiPlugins()).toEqual([aiPlugin]);
  });

  it('imports once and hands every caller the same array', async () => {
    const importer = vi.fn(async () => ({ aiPlugin }));
    _setCanvasAiPluginImporterForTests(importer);
    const [a, b] = await Promise.all([loadCanvasAiPlugins(), loadCanvasAiPlugins()]);
    const c = await loadCanvasAiPlugins();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(getLoadedCanvasAiPlugins()).toBe(a);
  });

  it('mounts without the plugin when the chunk fails to load', async () => {
    _setCanvasAiPluginImporterForTests(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    await expect(loadCanvasAiPlugins()).resolves.toEqual([]);
    expect(getLoadedCanvasAiPlugins()).toBeNull();
  });

  it('resolves to no plugins when the import is a stub without aiPlugin', async () => {
    _setCanvasAiPluginImporterForTests(async () => ({}));
    await expect(loadCanvasAiPlugins()).resolves.toEqual([]);
  });

  it('retries a failed chunk load on the next mount', async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ aiPlugin });
    _setCanvasAiPluginImporterForTests(importer);
    await expect(loadCanvasAiPlugins()).resolves.toEqual([]);
    await expect(loadCanvasAiPlugins()).resolves.toEqual([aiPlugin]);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('caches the answer when the build has no copilot (stub module)', async () => {
    const importer = vi.fn(async () => ({}));
    _setCanvasAiPluginImporterForTests(importer);
    await loadCanvasAiPlugins();
    await loadCanvasAiPlugins();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(getLoadedCanvasAiPlugins()).toEqual([]);
  });
});
