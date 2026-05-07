/**
 * Canvas admin UI surface. Mounted by <PageEditor> when
 * page.composition_mode === 'blocks'.
 */

export { SiteCanvasEditor } from './SiteCanvasEditor.js';
export { useCanvasLock, type LockState } from './useCanvasLock.js';
export { useCanvasOps, type CanvasOpsState } from './useCanvasOps.js';
export {
  CanvasService,
  type CanvasError,
  type ApplyResult,
  type LockResult,
  type RenderResult,
  type BlockDefSummary,
  type BlockSelection,
} from './canvas-service.js';
export { CanvasToolbar, type Viewport, VIEWPORT_WIDTHS } from './CanvasToolbar.js';
export { BlockPalette } from './BlockPalette.js';
export { PropertiesPanel } from './PropertiesPanel.js';
export { UndoStack, deriveInverse, labelForOp, type UndoEntry } from './undo-stack.js';
