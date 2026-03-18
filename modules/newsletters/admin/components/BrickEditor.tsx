import { useState, useCallback, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import {
  ChevronUpIcon,
  ChevronDownIcon,
  TrashIcon,
  Bars3Icon,
  PhotoIcon,
  ArrowUpTrayIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import {
  uploadNewsletterImage,
  validateNewsletterImage,
} from '@/utils/newsletter';

// Helper to determine if a field name suggests it's an image field
function isImageField(fieldName: string): boolean {
  const imageFieldPatterns = ['image', 'img', 'photo', 'picture', 'thumbnail', 'avatar', 'logo', 'banner', 'meme'];
  const lowerName = fieldName.toLowerCase();
  return imageFieldPatterns.some(pattern => lowerName.includes(pattern));
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

interface BrickEditorProps {
  brick: EditionBrick;
  onUpdate: (content: Record<string, unknown>) => void;
  onDelete: () => void;
}

interface SchemaField {
  type: string;
  title?: string;
  format?: string;
  default?: unknown;
  items?: {
    type: string;
  };
}

export function BrickEditor({ brick, onUpdate, onDelete }: BrickEditorProps) {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [uploadingFields, setUploadingFields] = useState<Record<string, boolean>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: brick.id,
    data: {
      type: 'brick',
      brick,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const schema = brick.brick_template.schema as { properties?: Record<string, SchemaField> };
  const properties = schema?.properties || {};

  const handleFieldChange = useCallback((fieldName: string, value: unknown) => {
    onUpdate({
      ...brick.content,
      [fieldName]: value,
    });
  }, [brick.content, onUpdate]);

  const handleArrayFieldChange = useCallback((fieldName: string, index: number, value: unknown) => {
    const currentArray = (brick.content[fieldName] as unknown[]) || [];
    const newArray = [...currentArray];
    newArray[index] = value;
    handleFieldChange(fieldName, newArray);
  }, [brick.content, handleFieldChange]);

  const handleAddArrayItem = useCallback((fieldName: string) => {
    const currentArray = (brick.content[fieldName] as unknown[]) || [];
    handleFieldChange(fieldName, [...currentArray, '']);
  }, [brick.content, handleFieldChange]);

  const handleRemoveArrayItem = useCallback((fieldName: string, index: number) => {
    const currentArray = (brick.content[fieldName] as unknown[]) || [];
    handleFieldChange(fieldName, currentArray.filter((_, i) => i !== index));
  }, [brick.content, handleFieldChange]);

  const handleImageUpload = useCallback(async (fieldName: string, file: File) => {
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
    event.target.value = '';
  }, [handleImageUpload]);

  const renderField = (fieldName: string, fieldSchema: SchemaField) => {
    const value = brick.content[fieldName];
    const label = fieldSchema.title || fieldName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // String field
    if (fieldSchema.type === 'string') {
      // HTML/Rich text field
      if (fieldSchema.format === 'html') {
        return (
          <div key={fieldName} className="mb-3">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              {label}
            </label>
            <RichTextEditor
              content={(value as string) || ''}
              onChange={(html) => handleFieldChange(fieldName, html)}
              className="min-h-[100px]"
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
            <div key={fieldName} className="mb-3">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                {label}
              </label>

              {/* Image preview if URL exists */}
              {currentValue && (
                <div className="relative mb-2 inline-block">
                  <img
                    src={currentValue}
                    alt={label}
                    className="max-w-[150px] max-h-[100px] rounded border border-gray-200 dark:border-gray-700 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <button
                    onClick={() => handleFieldChange(fieldName, '')}
                    className="absolute -top-1.5 -right-1.5 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors"
                    title="Remove image"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </div>
              )}

              <div className="flex gap-1.5">
                <input
                  type="file"
                  ref={(el) => { fileInputRefs.current[fieldName] = el; }}
                  onChange={(e) => handleFileSelect(fieldName, e)}
                  accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                  className="hidden"
                />

                <Button
                  variant="outlined"
                  onClick={() => fileInputRefs.current[fieldName]?.click()}
                  disabled={isUploading}
                  className="gap-1 flex-shrink-0 text-xs px-2 py-1"
                >
                  {isUploading ? (
                    <span className="animate-spin">⏳</span>
                  ) : (
                    <ArrowUpTrayIcon className="w-3.5 h-3.5" />
                  )}
                  {isUploading ? 'Uploading...' : 'Upload'}
                </Button>

                <input
                  type="url"
                  value={currentValue}
                  onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                  placeholder="Or paste URL..."
                  className="flex-1 px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500"
                />
              </div>

              <p className="mt-0.5 text-xs text-gray-400">
                <PhotoIcon className="w-3 h-3 inline mr-0.5" />
                Upload (max 10MB) or paste URL
              </p>
            </div>
          );
        }

        // Regular URL field
        return (
          <div key={fieldName} className="mb-3">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              {label}
            </label>
            <input
              type="url"
              value={currentValue}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              placeholder={`Enter ${label.toLowerCase()}...`}
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        );
      }

      // Regular text field
      return (
        <div key={fieldName} className="mb-3">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            {label}
          </label>
          <input
            type="text"
            value={(value as string) || ''}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            placeholder={`Enter ${label.toLowerCase()}...`}
            className="w-full px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
      );
    }

    // Array of strings field
    if (fieldSchema.type === 'array' && fieldSchema.items?.type === 'string') {
      const arrayValue = (value as string[]) || [];

      return (
        <div key={fieldName} className="mb-3">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
            {label}
          </label>
          <div className="space-y-1.5">
            {arrayValue.map((item, index) => (
              <div key={index} className="flex gap-1.5">
                <input
                  type="text"
                  value={item || ''}
                  onChange={(e) => handleArrayFieldChange(fieldName, index, e.target.value)}
                  className="flex-1 px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                  placeholder="Enter bullet point..."
                />
                <button
                  onClick={() => handleRemoveArrayItem(fieldName, index)}
                  className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            ))}
            <Button
              variant="flat"
              onClick={() => handleAddArrayItem(fieldName)}
              className="text-xs px-2 py-1"
            >
              + Add bullet point
            </Button>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900/50 overflow-hidden"
    >
      {/* Brick Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
        <button
          {...attributes}
          {...listeners}
          className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded cursor-grab active:cursor-grabbing"
        >
          <Bars3Icon className="w-4 h-4 text-gray-400" />
        </button>

        <span className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-300">
          {brick.brick_template.name}
        </span>

        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
        >
          {isCollapsed ? (
            <ChevronDownIcon className="w-3.5 h-3.5 text-gray-500" />
          ) : (
            <ChevronUpIcon className="w-3.5 h-3.5 text-gray-500" />
          )}
        </button>

        <button
          onClick={onDelete}
          className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded text-red-500"
        >
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Brick Content */}
      {!isCollapsed && (
        <div className="p-3">
          {Object.entries(properties).map(([fieldName, fieldSchema]) =>
            renderField(fieldName, fieldSchema)
          )}
        </div>
      )}
    </div>
  );
}

export default BrickEditor;
