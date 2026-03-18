import { useState, useCallback, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getSurveyBaseUrl } from '@/config/brands';
import { toast } from 'sonner';
import {
  ChevronUpIcon,
  ChevronDownIcon,
  TrashIcon,
  Bars3Icon,
  PlusIcon,
  PhotoIcon,
  ArrowUpTrayIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Card, Button } from '@/components/ui';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import { BrickEditor } from './BrickEditor';
import {
  uploadNewsletterImage,
  validateNewsletterImage,
} from '@/utils/newsletter';

export interface BlockTemplate {
  id: string;
  name: string;
  block_type: string;
  description: string | null;
  has_bricks: boolean;
  schema: Record<string, unknown>;
}

export interface BrickTemplate {
  id: string;
  name: string;
  brick_type: string;
  schema: Record<string, unknown>;
}

export interface EditionBrick {
  id: string;
  brick_template_id: string;
  brick_template: BrickTemplate;
  content: Record<string, unknown>;
  sort_order: number;
}

export interface EditionBlock {
  id: string;
  block_template_id: string;
  block_template: BlockTemplate;
  content: Record<string, unknown>;
  sort_order: number;
  bricks: EditionBrick[];
}

interface BlockEditorProps {
  block: EditionBlock;
  availableBrickTemplates: BrickTemplate[];
  onUpdate: (blockId: string, content: Record<string, unknown>) => void;
  onDelete: (blockId: string) => void;
  onAddBrick: (blockId: string, brickTemplateId: string) => void;
  onUpdateBrick: (blockId: string, brickId: string, content: Record<string, unknown>) => void;
  onDeleteBrick: (blockId: string, brickId: string) => void;
  onReorderBricks: (blockId: string, bricks: EditionBrick[]) => void;
}

interface SchemaField {
  type: string;
  title?: string;
  format?: string;
  default?: unknown;
  items?: {
    type: string;
    properties?: Record<string, SchemaField>;
    required?: string[];
  };
  properties?: Record<string, SchemaField>;
}

// Helper to determine if a field name suggests it's an image field
function isImageField(fieldName: string): boolean {
  const imageFieldPatterns = ['image', 'img', 'photo', 'picture', 'thumbnail', 'avatar', 'logo', 'banner', 'meme'];
  const lowerName = fieldName.toLowerCase();
  return imageFieldPatterns.some(pattern => lowerName.includes(pattern));
}

// Helper to strip HTML tags from content
function stripHtml(html: string): string {
  // Create a temporary div to parse HTML and extract text
  if (typeof document !== 'undefined') {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }
  // Fallback for SSR - basic regex strip
  return html.replace(/<[^>]*>/g, '');
}

// Generate the hot take poll URL from content
function generateHotTakePollUrl(body: string, option1Label: string, option2Label: string): string {
  const baseUrl = getSurveyBaseUrl();
  const question = stripHtml(body);

  const params = new URLSearchParams({
    sid: 'yesno',
    question: question,
    y: option1Label || '',
    n: option2Label || '',
    oneclick: 'true',
    accept: 'true',
  });

  return `${baseUrl}?${params.toString()}`;
}

export function BlockEditor({
  block,
  availableBrickTemplates,
  onUpdate,
  onDelete,
  onAddBrick,
  onUpdateBrick,
  onDeleteBrick,
  onReorderBricks,
}: BlockEditorProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [showBrickSelector, setShowBrickSelector] = useState(false);
  const [uploadingFields, setUploadingFields] = useState<Record<string, boolean>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Sensors for brick drag and drop
  const brickSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Handle brick drag end
  const handleBrickDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const sortedBricks = [...block.bricks].sort((a, b) => a.sort_order - b.sort_order);
      const oldIndex = sortedBricks.findIndex((b) => b.id === active.id);
      const newIndex = sortedBricks.findIndex((b) => b.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const reorderedBricks = arrayMove(sortedBricks, oldIndex, newIndex).map((brick, index) => ({
          ...brick,
          sort_order: index,
        }));
        onReorderBricks(block.id, reorderedBricks);
      }
    }
  }, [block.id, block.bricks, onReorderBricks]);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: block.id,
    data: {
      type: 'block',
      block,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const schema = block.block_template.schema as { properties?: Record<string, SchemaField> };
  const properties = schema?.properties || {};

  const handleFieldChange = useCallback((fieldName: string, value: unknown) => {
    const newContent = {
      ...block.content,
      [fieldName]: value,
    };

    // For hot_take blocks, auto-generate the poll URL when relevant fields change
    if (block.block_template.block_type === 'hot_take') {
      const body = (fieldName === 'body' ? value : newContent.body) as string || '';
      const option1Label = (fieldName === 'poll_option_1_label' ? value : newContent.poll_option_1_label) as string || '';
      const option2Label = (fieldName === 'poll_option_2_label' ? value : newContent.poll_option_2_label) as string || '';

      // Only generate URL if we have at least one button label
      if (option1Label || option2Label) {
        const pollUrl = generateHotTakePollUrl(body, option1Label, option2Label);
        newContent.poll_option_1_link = pollUrl;
        newContent.poll_option_2_link = pollUrl;
      }
    }

    onUpdate(block.id, newContent);
  }, [block.id, block.content, block.block_template.block_type, onUpdate]);

  const handleArrayFieldChange = useCallback((fieldName: string, index: number, value: unknown) => {
    const currentArray = (block.content[fieldName] as unknown[]) || [];
    const newArray = [...currentArray];
    newArray[index] = value;
    handleFieldChange(fieldName, newArray);
  }, [block.content, handleFieldChange]);

  const handleAddArrayItem = useCallback((fieldName: string, defaultValue: unknown) => {
    const currentArray = (block.content[fieldName] as unknown[]) || [];
    handleFieldChange(fieldName, [...currentArray, defaultValue]);
  }, [block.content, handleFieldChange]);

  const handleRemoveArrayItem = useCallback((fieldName: string, index: number) => {
    const currentArray = (block.content[fieldName] as unknown[]) || [];
    handleFieldChange(fieldName, currentArray.filter((_, i) => i !== index));
  }, [block.content, handleFieldChange]);

  const handleImageUpload = useCallback(async (fieldName: string, file: File) => {
    // Validate the file first
    const validation = validateNewsletterImage(file);
    if (!validation.valid) {
      toast.error(validation.error);
      return;
    }

    setUploadingFields(prev => ({ ...prev, [fieldName]: true }));

    try {
      const result = await uploadNewsletterImage(file);
      if (result.success && result.url) {
        handleFieldChange(fieldName, result.url);
        toast.success('Image uploaded successfully');
      } else {
        toast.error(result.error || 'Failed to upload image');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to upload image');
    } finally {
      setUploadingFields(prev => ({ ...prev, [fieldName]: false }));
    }
  }, [handleFieldChange]);

  const handleFileSelect = useCallback((fieldName: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleImageUpload(fieldName, file);
    }
    // Reset the input so the same file can be selected again
    event.target.value = '';
  }, [handleImageUpload]);

  const renderField = (fieldName: string, fieldSchema: SchemaField) => {
    const value = block.content[fieldName];
    const label = fieldSchema.title || fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // String field
    if (fieldSchema.type === 'string') {
      // HTML/Rich text field
      if (fieldSchema.format === 'html') {
        return (
          <div key={fieldName} className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {label}
            </label>
            <RichTextEditor
              content={(value as string) || ''}
              onChange={(html) => handleFieldChange(fieldName, html)}
              className="min-h-[150px]"
            />
          </div>
        );
      }

      // URL field - with image upload support for image-related fields
      if (fieldSchema.format === 'uri') {
        const showImageUpload = isImageField(fieldName);
        const isUploading = uploadingFields[fieldName];
        const currentValue = (value as string) || '';

        if (showImageUpload) {
          return (
            <div key={fieldName} className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {label}
              </label>

              {/* Image preview if URL exists */}
              {currentValue && (
                <div className="relative mb-3 inline-block">
                  <img
                    src={currentValue}
                    alt={label}
                    className="max-w-[200px] max-h-[150px] rounded-lg border border-gray-200 dark:border-gray-700 object-cover"
                    onError={(e) => {
                      // Hide broken images
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <button
                    onClick={() => handleFieldChange(fieldName, '')}
                    className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                    title="Remove image"
                  >
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Upload and URL input area */}
              <div className="flex gap-2">
                {/* Hidden file input */}
                <input
                  type="file"
                  ref={(el) => { fileInputRefs.current[fieldName] = el; }}
                  onChange={(e) => handleFileSelect(fieldName, e)}
                  accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                  className="hidden"
                />

                {/* Upload button */}
                <Button
                  variant="outlined"
                  onClick={() => fileInputRefs.current[fieldName]?.click()}
                  disabled={isUploading}
                  className="gap-1 flex-shrink-0 text-sm px-3 py-1.5"
                >
                  {isUploading ? (
                    <>
                      <span className="animate-spin">⏳</span>
                      Uploading...
                    </>
                  ) : (
                    <>
                      <ArrowUpTrayIcon className="w-4 h-4" />
                      Upload
                    </>
                  )}
                </Button>

                {/* URL input */}
                <input
                  type="url"
                  value={currentValue}
                  onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                  placeholder="Or paste image URL..."
                  className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm"
                />
              </div>

              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                <PhotoIcon className="w-3 h-3 inline mr-1" />
                Upload an image (max 10MB) or paste a URL
              </p>
            </div>
          );
        }

        // Regular URL field (non-image)
        return (
          <div key={fieldName} className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {label}
            </label>
            <input
              type="url"
              value={currentValue}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              placeholder={`Enter ${label.toLowerCase()}...`}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        );
      }

      // Date field
      if (fieldSchema.format === 'date') {
        return (
          <div key={fieldName} className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {label}
            </label>
            <input
              type="date"
              value={(value as string) || ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        );
      }

      // Regular text field
      return (
        <div key={fieldName} className="mb-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {label}
          </label>
          <input
            type="text"
            value={(value as string) || ''}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            placeholder={`Enter ${label.toLowerCase()}...`}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
      );
    }

    // Array field
    if (fieldSchema.type === 'array') {
      const arrayValue = (value as unknown[]) || [];
      const itemSchema = fieldSchema.items;

      // Array of strings
      if (itemSchema?.type === 'string') {
        return (
          <div key={fieldName} className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {label}
            </label>
            <div className="space-y-2">
              {arrayValue.map((item, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={(item as string) || ''}
                    onChange={(e) => handleArrayFieldChange(fieldName, index, e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                  <Button
                    variant="outlined"
                    color="error"
                    isIcon
                    onClick={() => handleRemoveArrayItem(fieldName, index)}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outlined"
                onClick={() => handleAddArrayItem(fieldName, '')}
                className="gap-1 text-sm px-3 py-1.5"
              >
                <PlusIcon className="w-4 h-4" />
                Add Item
              </Button>
            </div>
          </div>
        );
      }

      // Array of objects
      if (itemSchema?.type === 'object' && itemSchema.properties) {
        return (
          <div key={fieldName} className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {label}
            </label>
            <div className="space-y-3">
              {arrayValue.map((item, index) => (
                <Card key={index} className="p-3 bg-gray-50 dark:bg-gray-800/50">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-medium text-gray-500">Item {index + 1}</span>
                    <Button
                      variant="flat"
                      color="error"
                      isIcon
                      onClick={() => handleRemoveArrayItem(fieldName, index)}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="space-y-2">
                    {Object.entries(itemSchema.properties).map(([propName, propSchema]) => {
                      const propValue = (item as Record<string, unknown>)?.[propName];
                      const propLabel = propSchema.title || propName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

                      // Rich text/HTML field within array item
                      if (propSchema.format === 'html') {
                        return (
                          <div key={propName}>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                              {propLabel}
                            </label>
                            <RichTextEditor
                              content={(propValue as string) || ''}
                              onChange={(html) => {
                                const newItem = { ...(item as Record<string, unknown>), [propName]: html };
                                handleArrayFieldChange(fieldName, index, newItem);
                              }}
                              className="min-h-[100px]"
                            />
                          </div>
                        );
                      }

                      // Regular input field
                      return (
                        <div key={propName}>
                          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                            {propLabel}
                          </label>
                          <input
                            type={propSchema.format === 'uri' ? 'url' : 'text'}
                            value={(propValue as string) || ''}
                            onChange={(e) => {
                              const newItem = { ...(item as Record<string, unknown>), [propName]: e.target.value };
                              handleArrayFieldChange(fieldName, index, newItem);
                            }}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                          />
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
              <Button
                variant="outlined"
                onClick={() => {
                  const defaultItem: Record<string, string> = {};
                  Object.keys(itemSchema.properties || {}).forEach(key => {
                    defaultItem[key] = '';
                  });
                  handleAddArrayItem(fieldName, defaultItem);
                }}
                className="gap-1 text-sm px-3 py-1.5"
              >
                <PlusIcon className="w-4 h-4" />
                Add {label.replace(/s$/, '')}
              </Button>
            </div>
          </div>
        );
      }
    }

    return null;
  };

  // Filter brick templates for this block type
  const filteredBrickTemplates = availableBrickTemplates.filter(
    bt => bt.id && block.block_template.has_bricks
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        bg-white dark:bg-gray-900 border border-primary-500 rounded-xl
        shadow-sm hover:shadow-md transition-shadow
        ${isDragging ? 'ring-2 ring-primary-500 shadow-xl z-50' : ''}
      `}
    >
      {/* Block Header */}
      <div className="flex items-center gap-2 p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 rounded-t-xl">
        <button
          {...attributes}
          {...listeners}
          className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded cursor-grab active:cursor-grabbing"
        >
          <Bars3Icon className="w-4 h-4 text-gray-400" />
        </button>

        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            {block.block_template.name}
          </h3>
          {block.block_template.description && (
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {block.block_template.description}
            </p>
          )}
        </div>

        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
        >
          {isCollapsed ? (
            <ChevronDownIcon className="w-4 h-4 text-gray-500" />
          ) : (
            <ChevronUpIcon className="w-4 h-4 text-gray-500" />
          )}
        </button>

        <button
          onClick={() => onDelete(block.id)}
          className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded text-red-500"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Block Content */}
      {!isCollapsed && (
        <div className="p-4">
          {/* Render schema fields */}
          {Object.entries(properties).map(([fieldName, fieldSchema]) => {
            // Hide poll link fields for hot_take blocks - they are auto-generated
            if (block.block_template.block_type === 'hot_take' &&
                (fieldName === 'poll_option_1_link' || fieldName === 'poll_option_2_link')) {
              return null;
            }
            return renderField(fieldName, fieldSchema);
          })}

          {/* Bricks section for blocks that support them */}
          {block.block_template.has_bricks && (
            <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Content Items
                </h4>
                <Button
                  variant="outlined"
                  onClick={() => setShowBrickSelector(!showBrickSelector)}
                  className="gap-1 text-sm px-3 py-1.5"
                >
                  <PlusIcon className="w-4 h-4" />
                  Add Content
                </Button>
              </div>

              {/* Brick Selector */}
              {showBrickSelector && (
                <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <p className="text-xs text-gray-500 mb-2">Select content type:</p>
                  <div className="flex flex-wrap gap-2">
                    {filteredBrickTemplates.map((bt) => (
                      <Button
                        key={bt.id}
                        variant="outlined"
                        onClick={() => {
                          onAddBrick(block.id, bt.id);
                          setShowBrickSelector(false);
                        }}
                        className="text-sm px-3 py-1.5"
                      >
                        {bt.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* Bricks List */}
              <DndContext
                sensors={brickSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleBrickDragEnd}
              >
                <SortableContext
                  items={block.bricks.sort((a, b) => a.sort_order - b.sort_order).map(b => b.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-3">
                    {block.bricks
                      .sort((a, b) => a.sort_order - b.sort_order)
                      .map((brick) => (
                        <BrickEditor
                          key={brick.id}
                          brick={brick}
                          onUpdate={(content) => onUpdateBrick(block.id, brick.id, content)}
                          onDelete={() => onDeleteBrick(block.id, brick.id)}
                        />
                      ))}
                  </div>
                </SortableContext>
              </DndContext>

              {block.bricks.length === 0 && !showBrickSelector && (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                  No content items yet. Click "Add Content" to get started.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BlockEditor;
