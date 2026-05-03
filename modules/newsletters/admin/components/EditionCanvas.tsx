import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { PlusIcon, LinkIcon, ChevronDoubleLeftIcon, ChevronDoubleRightIcon } from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { toast } from 'sonner';
import { BlockPalette, type BlockTemplate as PaletteBlockTemplate } from './BlockPalette';
import { BlockEditor, type EditionBlock, type BrickTemplate } from './BlockEditor';
import { HtmlPreview } from './HtmlPreview';
import {
  type NewsletterEdition,
  type BlockTemplate,
  type EditionBrick,
  type GeneratedLink,
  generateEditionShortLinks,
  extractEditionLinks,
} from '../utils';

interface EditionCanvasProps {
  edition: NewsletterEdition;
  blockTemplates: (PaletteBlockTemplate & BlockTemplate)[];
  brickTemplates: BrickTemplate[];
  collectionMetadata?: Record<string, unknown>;
  onChange: (edition: NewsletterEdition) => void;
  onSave: (options?: { silent?: boolean }) => Promise<void> | void;
  onStatusChange?: (status: string) => void;
  isSaving?: boolean;
}

interface LinkGenerationProgress {
  isGenerating: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
}

// Drop indicator between blocks for positional insertion
function DropIndicator({ id, isOver }: { id: string; isOver: boolean }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`transition-all duration-150 mx-2 rounded ${
        isOver ? 'h-2 bg-blue-400 my-1' : 'h-0.5 bg-transparent'
      }`}
    />
  );
}

export function EditionCanvas({
  edition,
  blockTemplates,
  brickTemplates,
  collectionMetadata = {},
  onChange,
  onSave,
  onStatusChange,
  isSaving = false,
}: EditionCanvasProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [overDropId, setOverDropId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [showPalette, setShowPalette] = useState(true);
  const [linkProgress, setLinkProgress] = useState<LinkGenerationProgress>({
    isGenerating: false, total: 0, created: 0, updated: 0, errors: 0,
  });
  const [redirectsGeneratedHash, setRedirectsGeneratedHash] = useState<string | null>(null);
  const [generatedLinks, setGeneratedLinks] = useState<GeneratedLink[]>([]);

  // Resizable preview panel
  const [previewWidth, setPreviewWidth] = useState(() => {
    if (typeof window === 'undefined') return 650;
    const saved = localStorage.getItem('newsletter-preview-width');
    return saved ? parseInt(saved) : 650;
  });
  const isResizing = useRef(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = previewWidth;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const maxWidth = window.innerWidth - 500;
      const newWidth = Math.max(400, Math.min(startWidth + delta, maxWidth));
      setPreviewWidth(newWidth);
    };
    const onUp = () => {
      isResizing.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('newsletter-preview-width', String(previewWidth));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [previewWidth]);

  // Edition content hash for redirect tracking
  const editionContentHash = useMemo(() => {
    try {
      const contentForHash = JSON.stringify({
        blocks: edition.blocks.map(b => ({
          id: b.id, content: b.content,
          bricks: b.bricks?.map(br => ({ id: br.id, content: br.content })),
        })),
        edition_date: edition.edition_date,
      });
      let hash = 0;
      for (let i = 0; i < contentForHash.length; i++) {
        hash = ((hash << 5) - hash) + contentForHash.charCodeAt(i);
        hash = hash & hash;
      }
      return hash.toString();
    } catch { return null; }
  }, [edition]);

  const redirectsNeedUpdate = useMemo(() => {
    if (redirectsGeneratedHash === null) return true;
    return editionContentHash !== redirectsGeneratedHash;
  }, [redirectsGeneratedHash, editionContentHash]);

  const trackableLinkCount = useMemo(() => {
    try { return extractEditionLinks(edition).length; } catch { return 0; }
  }, [edition]);

  const handleGenerateLinks = useCallback(async () => {
    if (edition.id === 'new') {
      toast.error('Please save the edition first before generating links');
      return;
    }
    const redirectProvider = collectionMetadata.redirect_provider as string | null;
    const channels: ('html' | 'substack' | 'beehiiv')[] = ['html'];
    const totalLinks = trackableLinkCount * channels.length;
    setLinkProgress({ isGenerating: true, total: totalLinks, created: 0, updated: 0, errors: 0 });

    try {
      const result = await generateEditionShortLinks(edition, channels, redirectProvider);
      setLinkProgress({ isGenerating: false, total: totalLinks, created: result.created, updated: result.updated, errors: result.errors });
      if (result.errorMessages.length > 0) console.error('Link generation errors:', result.errorMessages);
      if (result.links.length > 0) setGeneratedLinks(result.links);

      if (result.success) {
        toast.success(`Generated ${result.created} new links, updated ${result.updated} existing`);
        setRedirectsGeneratedHash(editionContentHash);
      } else if (result.errors > 0) {
        const successCount = result.created + result.updated;
        if (successCount > 0) {
          toast.warning(`Generated ${successCount} links, but ${result.errors} failed.`);
          setRedirectsGeneratedHash(editionContentHash);
        } else {
          toast.error(`Failed to generate ${result.errors} links.`);
        }
      }
    } catch (error) {
      console.error('Error generating links:', error);
      setLinkProgress(prev => ({ ...prev, isGenerating: false, errors: prev.total }));
      toast.error('Failed to generate short links');
    }
  }, [edition, trackableLinkCount, editionContentHash, collectionMetadata]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Insert block at specific index
  const handleInsertBlock = useCallback((templateId: string, index: number) => {
    const template = blockTemplates.find(t => t.id === templateId);
    if (!template) return;

    const newBlock: EditionBlock = {
      id: crypto.randomUUID(),
      block_template: template,
      content: {},
      sort_order: index,
      bricks: [],
    };

    const updatedBlocks = [...edition.blocks];
    updatedBlocks.splice(index, 0, newBlock);

    onChange({
      ...edition,
      blocks: updatedBlocks.map((block, i) => ({ ...block, sort_order: i })),
    });
  }, [blockTemplates, edition, onChange]);

  // Add block at end (fallback)
  const handleAddBlock = useCallback((templateId: string) => {
    handleInsertBlock(templateId, edition.blocks.length);
  }, [handleInsertBlock, edition.blocks.length]);

  const handleUpdateBlock = useCallback((blockId: string, content: Record<string, unknown>) => {
    onChange({
      ...edition,
      blocks: edition.blocks.map(block =>
        block.id === blockId ? { ...block, content } : block
      ),
    });
  }, [edition, onChange]);

  const handleDeleteBlock = useCallback((blockId: string) => {
    onChange({
      ...edition,
      blocks: edition.blocks
        .filter(block => block.id !== blockId)
        .map((block, index) => ({ ...block, sort_order: index })),
    });
  }, [edition, onChange]);

  const handleAddBrick = useCallback((blockId: string, brickTemplateId: string) => {
    const brickTemplate = brickTemplates.find(t => t.id === brickTemplateId);
    if (!brickTemplate) return;

    onChange({
      ...edition,
      blocks: edition.blocks.map(block => {
        if (block.id !== blockId) return block;
        const newBrick: EditionBrick = {
          id: crypto.randomUUID(),
          brick_template: brickTemplate,
          content: {},
          sort_order: block.bricks.length,
        };
        return { ...block, bricks: [...block.bricks, newBrick] };
      }),
    });
  }, [brickTemplates, edition, onChange]);

  const handleUpdateBrick = useCallback((blockId: string, brickId: string, content: Record<string, unknown>) => {
    onChange({
      ...edition,
      blocks: edition.blocks.map(block => {
        if (block.id !== blockId) return block;
        return {
          ...block,
          bricks: block.bricks.map(brick =>
            brick.id === brickId ? { ...brick, content } : brick
          ),
        };
      }),
    });
  }, [edition, onChange]);

  const handleDeleteBrick = useCallback((blockId: string, brickId: string) => {
    onChange({
      ...edition,
      blocks: edition.blocks.map(block => {
        if (block.id !== blockId) return block;
        return {
          ...block,
          bricks: block.bricks
            .filter(brick => brick.id !== brickId)
            .map((brick, index) => ({ ...brick, sort_order: index })),
        };
      }),
    });
  }, [edition, onChange]);

  const handleReorderBricks = useCallback((blockId: string, bricks: EditionBrick[]) => {
    onChange({
      ...edition,
      blocks: edition.blocks.map(block =>
        block.id === blockId ? { ...block, bricks } : block
      ),
    });
  }, [edition, onChange]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    if (event.active.data.current?.type === 'palette-block') {
      setActiveTemplateId(event.active.data.current.templateId);
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverDropId(over ? String(over.id) : null);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveTemplateId(null);
    setOverDropId(null);

    if (!over) return;

    // Handle palette drop — insert at position
    if (active.data.current?.type === 'palette-block') {
      const templateId = active.data.current.templateId;
      const overId = String(over.id);

      if (overId.startsWith('insert-')) {
        const insertIndex = parseInt(overId.replace('insert-', ''));
        handleInsertBlock(templateId, insertIndex);
      } else if (overId === 'canvas-drop-zone' || edition.blocks.some(b => b.id === overId)) {
        // Fallback: append to end
        handleAddBlock(templateId);
      }
      return;
    }

    // Handle block reordering
    if (active.data.current?.type === 'block' && active.id !== over.id) {
      const oldIndex = edition.blocks.findIndex(b => b.id === active.id);
      const newIndex = edition.blocks.findIndex(b => b.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const reorderedBlocks = arrayMove(edition.blocks, oldIndex, newIndex)
          .map((block, index) => ({ ...block, sort_order: index }));
        onChange({ ...edition, blocks: reorderedBlocks });
      }
    }
  }, [edition, onChange, handleAddBlock, handleInsertBlock]);

  const editorBlocks = useMemo(() => {
    return edition.blocks.map(block => ({
      ...block,
      templates_block_def_id: block.block_template.id,
      bricks: block.bricks.map(brick => ({
        ...brick,
        templates_brick_def_id: brick.brick_template.id,
      })),
    }));
  }, [edition.blocks]);

  const activeBlock = activeId ? edition.blocks.find(b => b.id === activeId) : null;
  const isDraggingFromPalette = activeTemplateId !== null;
  const activeTemplate = activeTemplateId ? blockTemplates.find(t => t.id === activeTemplateId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div>
        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-3">
            {/* Title & Date */}
            <input
              type="text"
              value={edition.subject || ''}
              onChange={(e) => onChange({ ...edition, subject: e.target.value })}
              placeholder="Edition title…"
              className="flex-1 min-w-0 px-3 py-1.5 text-sm font-medium border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
            />
            <input
              type="date"
              value={edition.edition_date || ''}
              onChange={(e) => onChange({ ...edition, edition_date: e.target.value })}
              className="w-[150px] px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
            />
            {onStatusChange && (
              <select
                value={(edition as any).status || 'draft'}
                onChange={(e) => onStatusChange(e.target.value)}
                className="px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              >
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            )}
            <div className="flex-shrink-0 border-l border-[var(--gray-a4)] h-6 mx-1" />
            <Button variant="outlined" onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? 'Hide Preview' : 'Show Preview'}
            </Button>
            {collectionMetadata.redirect_provider && (
              <Button
                variant={redirectsNeedUpdate && trackableLinkCount > 0 ? "soft" : "outlined"}
                color={redirectsNeedUpdate && trackableLinkCount > 0 ? "warning" : "neutral"}
                onClick={handleGenerateLinks}
                disabled={linkProgress.isGenerating || edition.id === 'new' || trackableLinkCount === 0}
                className="flex items-center gap-2"
              >
                <LinkIcon className="w-4 h-4" />
                {linkProgress.isGenerating ? 'Generating...'
                  : redirectsNeedUpdate && trackableLinkCount > 0 ? `Update Redirects (${trackableLinkCount})`
                  : linkProgress.created > 0 || linkProgress.updated > 0 ? `${linkProgress.created} created, ${linkProgress.updated} updated`
                  : 'Redirects Up to Date'}
              </Button>
            )}
            <Button color="primary" onClick={onSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Edition'}
            </Button>
          </div>

          {/* Main Content Area: palette + blocks + preview.
           * overflow-x-auto so when the combined min-widths of the three
           * columns exceed the viewport, the row scrolls horizontally
           * instead of squashing any one column to garbage. */}
          <div className="flex gap-4 overflow-x-auto">
            {/* Left Sidebar - Block Palette (collapsible) */}
            <div className={`flex-shrink-0 transition-all duration-200 ${showPalette ? 'w-64' : 'w-6'}`}>
              {showPalette ? (
                <BlockPalette templates={blockTemplates} onAddBlock={handleAddBlock} onCollapse={() => setShowPalette(false)} />
              ) : (
                <button
                  onClick={() => setShowPalette(true)}
                  className="w-6 py-2 flex items-center justify-center bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  title="Show blocks library"
                >
                  <ChevronDoubleRightIcon className="w-3.5 h-3.5 text-gray-400" />
                </button>
              )}
            </div>

            {/* Blocks Editor.
             * min-w-[360px]: blocks (especially AI Content) need at least
             * this width to render without text and buttons collapsing
             * one-letter-per-line. Combined with the resizable preview
             * panel (which has its own min/max), this means very narrow
             * total viewports get a horizontal scroll on the workspace
             * row instead of a shredded canvas. */}
            <div className="flex-1 min-w-[360px]">
              <Card className="p-4">
                {edition.blocks.length === 0 && !isDraggingFromPalette ? (
                  <div className="flex flex-col items-center justify-center h-64 text-center">
                    <PlusIcon className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" />
                    <p className="text-gray-500 dark:text-gray-400 mb-2">No blocks yet</p>
                    <p className="text-sm text-gray-400 dark:text-gray-500">
                      Drag blocks from the library or click to add them
                    </p>
                  </div>
                ) : (
                  <SortableContext items={edition.blocks.map(b => b.id)} strategy={verticalListSortingStrategy}>
                    <div>
                      {/* Drop indicator at top */}
                      {isDraggingFromPalette && (
                        <DropIndicator id="insert-0" isOver={overDropId === 'insert-0'} />
                      )}

                      {editorBlocks
                        .sort((a, b) => a.sort_order - b.sort_order)
                        .map((block, index) => (
                          <div key={block.id}>
                            <div className="mb-4">
                              <BlockEditor
                                block={block}
                                availableBrickTemplates={brickTemplates}
                                collectionMetadata={collectionMetadata}
                                onUpdate={handleUpdateBlock}
                                onDelete={handleDeleteBlock}
                                onAddBrick={handleAddBrick}
                                onUpdateBrick={handleUpdateBrick}
                                onDeleteBrick={handleDeleteBrick}
                                onReorderBricks={handleReorderBricks}
                                onSaveEdition={async () => { await onSave({ silent: true }); }}
                              />
                            </div>
                            {/* Drop indicator after each block */}
                            {isDraggingFromPalette && (
                              <DropIndicator
                                id={`insert-${index + 1}`}
                                isOver={overDropId === `insert-${index + 1}`}
                              />
                            )}
                          </div>
                        ))}
                    </div>
                  </SortableContext>
                )}
              </Card>
            </div>

            {/* Resize handle + Preview Panel */}
            {/* Resize handle + Preview Panel */}
            {showPreview && (
              <>
                <div
                  className="w-1.5 flex-shrink-0 cursor-col-resize bg-gray-200 dark:bg-gray-700 hover:bg-blue-400 dark:hover:bg-blue-500 transition-colors rounded mx-1"
                  onMouseDown={startResize}
                  title="Drag to resize"
                />
                <div style={{ width: previewWidth, flexShrink: 0 }}>
                  <HtmlPreview
                    edition={edition}
                    redirectsReady={!collectionMetadata.redirect_provider || (!redirectsNeedUpdate && trackableLinkCount > 0)}
                    generatedLinks={generatedLinks}
                    collectionMetadata={collectionMetadata}
                  />
                </div>
              </>
            )}
          </div>
      </div>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeBlock ? (
          <div className="bg-white dark:bg-gray-900 border-2 border-primary-500 shadow-2xl p-4 opacity-90">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {activeBlock.block_template.name}
            </p>
          </div>
        ) : activeTemplate ? (
          <div className="bg-white dark:bg-gray-900 border-2 border-primary-500 shadow-2xl p-4 opacity-90">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {activeTemplate.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Drop to add</p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default EditionCanvas;
