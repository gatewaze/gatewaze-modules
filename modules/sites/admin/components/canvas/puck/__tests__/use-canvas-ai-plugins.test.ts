// @ts-nocheck — vitest types resolved at workspace install time
/**
 * useCanvasAiPlugins() hook behaviour (linuxfoundation/lfx-self-serve#3762).
 * The sites harness has no React DOM, so React's hooks are replaced with a
 * minimal recorder: useState returns its initial value and records sets,
 * and useEffect queues the effect for the test to run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const effects: Array<() => void | (() => void)> = [];
let setCalls: unknown[] = [];

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const value = typeof init === 'function' ? (init as () => unknown)() : init;
    return [value, (next: unknown) => { setCalls.push(next); }];
  },
  useEffect: (fn: () => void | (() => void)) => { effects.push(fn); },
}));

import {
  _setCanvasAiPluginImporterForTests,
  loadCanvasAiPlugins,
  useCanvasAiPlugins,
} from '../load-canvas-ai-plugins.js';

const aiPlugin = { name: 'editor-ai-copilot' };

afterEach(() => {
  _setCanvasAiPluginImporterForTests(null);
  effects.length = 0;
  setCalls = [];
});

describe('useCanvasAiPlugins', () => {
  it('returns the cached array on first render after a load, without importing again', async () => {
    const importer = vi.fn(async () => ({ aiPlugin }));
    _setCanvasAiPluginImporterForTests(importer);
    const loaded = await loadCanvasAiPlugins();
    expect(useCanvasAiPlugins()).toBe(loaded);
    effects[0]();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('starts empty and sets the loaded plugin on a live mount', async () => {
    _setCanvasAiPluginImporterForTests(async () => ({ aiPlugin }));
    expect(useCanvasAiPlugins()).toEqual([]);
    effects[0]();
    await loadCanvasAiPlugins();
    expect(setCalls).toEqual([[aiPlugin]]);
  });

  it('does not set state after the editor unmounts', async () => {
    let resolve!: (v: unknown) => void;
    _setCanvasAiPluginImporterForTests(() => new Promise((r) => { resolve = r; }));
    useCanvasAiPlugins();
    const cleanup = effects[0]() as () => void;
    cleanup();
    resolve({ aiPlugin });
    await loadCanvasAiPlugins();
    expect(setCalls).toEqual([]);
  });
});
