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
import { PlusIcon, LinkIcon } from '@heroicons/react/24/outline';
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
  onChange: (edition: NewsletterEdition) => void;
  onSave: () => void;
  isSaving?: boolean;
}

interface LinkGenerationProgress {
  isGenerating: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
}

// Droppable canvas area component
function DroppableCanvas({
  children,
  isOver,
  isDraggingFromPalette,
}: {
  children: React.ReactNode;
  isOver: boolean;
  isDraggingFromPalette: boolean;
}) {
  const { setNodeRef } = useDroppable({
    id: 'canvas-drop-zone',
  });

  return (
    <div
      ref={setNodeRef}
      className={`
        min-h-full transition-all duration-200
        ${isOver && isDraggingFromPalette ? 'ring-2 ring-primary-500 ring-inset bg-primary-50/50 dark:bg-primary-900/20' : ''}
      `}
    >
      {children}
      {isDraggingFromPalette && (
        <div
          className={`
            mt-4 border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200
            ${isOver
              ? 'border-primary-500 bg-primary-100 dark:bg-primary-900/30'
              : 'border-gray-300 dark:border-gray-600'
            }
          `}
        >
          <PlusIcon className={`w-8 h-8 mx-auto mb-2 ${isOver ? 'text-primary-500' : 'text-gray-400'}`} />
          <p className={`text-sm font-medium ${isOver ? 'text-primary-600 dark:text-primary-400' : 'text-gray-500 dark:text-gray-400'}`}>
            {isOver ? 'Release to add block' : 'Drop block here'}
          </p>
        </div>
      )}
    </div>
  );
}

export function EditionCanvas({
  edition,
  blockTemplates,
  brickTemplates,
  onChange,
  onSave,
  isSaving = false,
}: EditionCanvasProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [isOverCanvas, setIsOverCanvas] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [linkProgress, setLinkProgress] = useState<LinkGenerationProgress>({
    isGenerating: false,
    total: 0,
    created: 0,
    updated: 0,
    errors: 0,
  });

  // Track whether redirects are up-to-date
  // Store a hash of the edition content when redirects were last generated
  const [redirectsGeneratedHash, setRedirectsGeneratedHash] = useState<string | null>(null);

  // Store generated links in memory so HtmlPreview can use them directly
  // (bypasses the DB roundtrip which may fail silently)
  const [generatedLinks, setGeneratedLinks] = useState<GeneratedLink[]>([]);

  // Compute a simple hash of edition content to detect changes
  const editionContentHash = useMemo(() => {
    try {
      // Create a hash from the edition's link-relevant content
      const contentForHash = JSON.stringify({
        blocks: edition.blocks.map(b => ({
          id: b.id,
          content: b.content,
          bricks: b.bricks?.map(br => ({ id: br.id, content: br.content })),
        })),
        edition_date: edition.edition_date,
      });
      // Simple hash function
      let hash = 0;
      for (let i = 0; i < contentForHash.length; i++) {
        const char = contentForHash.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString();
    } catch {
      return null;
    }
  }, [edition]);

  // Check if redirects need updating
  const redirectsNeedUpdate = useMemo(() => {
    // If no redirects have been generated yet
    if (redirectsGeneratedHash === null) return true;
    // If edition content has changed since last generation
    if (editionContentHash !== redirectsGeneratedHash) return true;
    return false;
  }, [redirectsGeneratedHash, editionContentHash]);

  // Count trackable links in the edition
  const trackableLinkCount = useMemo(() => {
    try {
      return extractEditionLinks(edition).length;
    } catch {
      return 0;
    }
  }, [edition]);

  // Handle generating short links
  const handleGenerateLinks = useCallback(async () => {
    if (edition.id === 'new') {
      toast.error('Please save the edition first before generating links');
      return;
    }

    const totalLinks = trackableLinkCount * 3; // 3 channels
    setLinkProgress({
      isGenerating: true,
      total: totalLinks,
      created: 0,
      updated: 0,
      errors: 0,
    });

    try {
      const result = await generateEditionShortLinks(edition);

      setLinkProgress({
        isGenerating: false,
        total: totalLinks,
        created: result.created,
        updated: result.updated,
        errors: result.errors,
      });

      // Log any error messages for debugging
      if (result.errorMessages.length > 0) {
        console.error('Link generation errors:', result.errorMessages);
      }

      // Store generated links in memory for HtmlPreview to use directly
      if (result.links.length > 0) {
        setGeneratedLinks(result.links);
      }

      if (result.success) {
        toast.success(
          `Generated ${result.created} new links, updated ${result.updated} existing`
        );
        // Mark redirects as up-to-date with current content hash
        setRedirectsGeneratedHash(editionContentHash);
      } else if (result.errors > 0) {
        // Show more detailed error message
        const successCount = result.created + result.updated;
        if (successCount > 0) {
          toast.warning(
            `Generated ${successCount} links, but ${result.errors} failed. Check console for details.`
          );
          // Still mark as generated if most links succeeded
          setRedirectsGeneratedHash(editionContentHash);
        } else {
          toast.error(`Failed to generate ${result.errors} links. Check console for details.`);
        }
      }
    } catch (error) {
      console.error('Error generating links:', error);
      setLinkProgress(prev => ({
        ...prev,
        isGenerating: false,
        errors: prev.total,
      }));
      toast.error('Failed to generate short links');
    }
  }, [edition, trackableLinkCount, editionContentHash]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle adding a block from palette
  const handleAddBlock = useCallback((templateId: string) => {
    const template = blockTemplates.find(t => t.id === templateId);
    if (!template) return;

    const newBlock: EditionBlock = {
      id: crypto.randomUUID(),
      block_template: template,
      content: {},
      sort_order: edition.blocks.length,
      bricks: [],
    };

    onChange({
      ...edition,
      blocks: [...edition.blocks, newBlock],
    });
  }, [blockTemplates, edition, onChange]);

  // Handle updating block content
  const handleUpdateBlock = useCallback((blockId: string, content: Record<string, unknown>) => {
    onChange({
      ...edition,
      blocks: edition.blocks.map(block =>
        block.id === blockId ? { ...block, content } : block
      ),
    });
  }, [edition, onChange]);

  // Handle deleting a block
  const handleDeleteBlock = useCallback((blockId: string) => {
    onChange({
      ...edition,
      blocks: edition.blocks
        .filter(block => block.id !== blockId)
        .map((block, index) => ({ ...block, sort_order: index })),
    });
  }, [edition, onChange]);

  // Handle adding a brick to a block
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

        return {
          ...block,
          bricks: [...block.bricks, newBrick],
        };
      }),
    });
  }, [brickTemplates, edition, onChange]);

  // Handle updating brick content
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

  // Handle deleting a brick
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

  // Handle reordering bricks within a block
  const handleReorderBricks = useCallback((blockId: string, bricks: EditionBrick[]) => {
    onChange({
      ...edition,
      blocks: edition.blocks.map(block =>
        block.id === blockId ? { ...block, bricks } : block
      ),
    });
  }, [edition, onChange]);

  // Drag handlers
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    // Track if dragging from palette
    if (event.active.data.current?.type === 'palette-block') {
      setActiveTemplateId(event.active.data.current.templateId);
    }
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    // Check if over the canvas drop zone or any block
    setIsOverCanvas(over?.id === 'canvas-drop-zone' || edition.blocks.some(b => b.id === over?.id));
  }, [edition.blocks]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setActiveTemplateId(null);
    setIsOverCanvas(false);

    if (!over) return;

    // Handle palette drop - adding new block
    if (active.data.current?.type === 'palette-block') {
      const templateId = active.data.current.templateId;
      // Drop on canvas zone or any existing block
      if (over.id === 'canvas-drop-zone' || edition.blocks.some(b => b.id === over.id)) {
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

        onChange({
          ...edition,
          blocks: reorderedBlocks,
        });
      }
    }
  }, [edition, onChange, handleAddBlock]);

  // Convert blocks for BlockEditor compatibility
  const editorBlocks = useMemo(() => {
    return edition.blocks.map(block => ({
      ...block,
      block_template_id: block.block_template.id,
      bricks: block.bricks.map(brick => ({
        ...brick,
        brick_template_id: brick.brick_template.id,
      })),
    }));
  }, [edition.blocks]);

  // Get active block for drag overlay
  const activeBlock = activeId
    ? edition.blocks.find(b => b.id === activeId)
    : null;

  // Check if we're dragging from the palette
  const isDraggingFromPalette = activeTemplateId !== null;

  // Get the template being dragged for the overlay
  const activeTemplate = activeTemplateId
    ? blockTemplates.find(t => t.id === activeTemplateId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full gap-4">
        {/* Left Sidebar - Block Palette */}
        <div className="w-64 flex-shrink-0">
          <BlockPalette
            templates={blockTemplates}
            onAddBlock={handleAddBlock}
          />
        </div>

        {/* Center - Editor Canvas */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Newsletter Configuration Header */}
          <Card className="p-4 mb-4">
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Edition Date
                  </label>
                  <input
                    type="date"
                    value={edition.edition_date}
                    onChange={(e) => onChange({ ...edition, edition_date: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Email Subject
                  </label>
                  <input
                    type="text"
                    value={edition.subject || ''}
                    onChange={(e) => onChange({ ...edition, subject: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    placeholder="Email subject line..."
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  Preheader Text
                  <span className="ml-1 text-gray-400 font-normal">(preview in inbox)</span>
                </label>
                <input
                  type="text"
                  value={edition.preheader || ''}
                  onChange={(e) => onChange({ ...edition, preheader: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Preview text shown before opening..."
                  maxLength={150}
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  variant="outlined"
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? 'Hide Preview' : 'Show Preview'}
                </Button>
                <Button
                  variant={redirectsNeedUpdate && trackableLinkCount > 0 ? "soft" : "outlined"}
                  color={redirectsNeedUpdate && trackableLinkCount > 0 ? "warning" : "neutral"}
                  onClick={handleGenerateLinks}
                  disabled={linkProgress.isGenerating || edition.id === 'new' || trackableLinkCount === 0}
                  className="flex items-center gap-2"
                >
                  <LinkIcon className="w-4 h-4" />
                  {linkProgress.isGenerating ? (
                    <span>Generating...</span>
                  ) : redirectsNeedUpdate && trackableLinkCount > 0 ? (
                    <span>Update Redirects ({trackableLinkCount * 3})</span>
                  ) : linkProgress.created > 0 || linkProgress.updated > 0 ? (
                    <span>
                      {linkProgress.created} created, {linkProgress.updated} updated
                    </span>
                  ) : (
                    <span>Redirects Up to Date</span>
                  )}
                </Button>
                <Button
                  color="primary"
                  onClick={onSave}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save Edition'}
                </Button>
              </div>
            </div>
          </Card>

          {/* Main Content Area */}
          <div className={`flex-1 flex gap-4 min-h-0 ${showPreview ? '' : ''}`}>
            {/* Blocks Editor */}
            <div className={`${showPreview ? 'w-1/2' : 'w-full'} overflow-y-auto`}>
              <Card className="p-4 min-h-full">
                <DroppableCanvas isOver={isOverCanvas} isDraggingFromPalette={isDraggingFromPalette}>
                  {edition.blocks.length === 0 && !isDraggingFromPalette ? (
                    <div className="flex flex-col items-center justify-center h-64 text-center">
                      <PlusIcon className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-3" />
                      <p className="text-gray-500 dark:text-gray-400 mb-2">
                        No blocks yet
                      </p>
                      <p className="text-sm text-gray-400 dark:text-gray-500">
                        Drag blocks from the library or click to add them
                      </p>
                    </div>
                  ) : edition.blocks.length === 0 ? null : (
                    <SortableContext
                      items={edition.blocks.map(b => b.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-4">
                        {editorBlocks
                          .sort((a, b) => a.sort_order - b.sort_order)
                          .map((block) => (
                            <BlockEditor
                              key={block.id}
                              block={block}
                              availableBrickTemplates={brickTemplates}
                              onUpdate={handleUpdateBlock}
                              onDelete={handleDeleteBlock}
                              onAddBrick={handleAddBrick}
                              onUpdateBrick={handleUpdateBrick}
                              onDeleteBrick={handleDeleteBrick}
                              onReorderBricks={handleReorderBricks}
                            />
                          ))}
                      </div>
                    </SortableContext>
                  )}
                </DroppableCanvas>
              </Card>
            </div>

            {/* Preview Panel */}
            {showPreview && (
              <div className="w-1/2 overflow-hidden">
                <HtmlPreview
                  edition={edition}
                  redirectsReady={!redirectsNeedUpdate && trackableLinkCount > 0}
                  generatedLinks={generatedLinks}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Drag Overlay */}
      <DragOverlay>
        {activeBlock ? (
          <div className="bg-white dark:bg-gray-900 border-2 border-primary-500 rounded-xl shadow-2xl p-4 opacity-90">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {activeBlock.block_template.name}
            </p>
          </div>
        ) : activeTemplate ? (
          <div className="bg-white dark:bg-gray-900 border-2 border-primary-500 rounded-xl shadow-2xl p-4 opacity-90">
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {activeTemplate.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Drop to add
            </p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export default EditionCanvas;
