/**
 * Lazy entry for the copilot's Puck plugin.
 *
 * Canvas hosts load this file with a dynamic import when an editor
 * mounts (see sites' load-canvas-ai-plugins.ts), so it, and the Puck
 * runtime it pulls in, stay out of the admin boot bundle.
 *
 * Do not rename this to `admin/index.ts`: the platform's Vite plugin
 * statically imports every module's `admin/index.*` at boot, which would
 * put the Puck editor back into every page's boot graph
 * (linuxfoundation/lfx-self-serve#3762).
 *
 * Per spec-canvas-ai-copilot.md §3.8.
 */

export { aiPlugin } from './components/aiPlugin.js';
