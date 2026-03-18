import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  DocumentTextIcon,
  SparklesIcon,
  MegaphoneIcon,
  GiftIcon,
  BriefcaseIcon,
  CpuChipIcon,
  UsersIcon,
  FaceSmileIcon,
  ChatBubbleBottomCenterTextIcon,
  HandRaisedIcon,
  Bars3BottomLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline';
import { Card } from '@/components/ui';

export interface BlockTemplate {
  id: string;
  name: string;
  block_type: string;
  description: string | null;
  has_bricks: boolean;
  sort_order: number;
}

interface BlockPaletteProps {
  templates: BlockTemplate[];
  onAddBlock: (templateId: string) => void;
}

const BLOCK_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  header: DocumentTextIcon,
  hot_take: SparklesIcon,
  sponsored_ad: MegaphoneIcon,
  hidden_gems: GiftIcon,
  job_of_week: BriefcaseIcon,
  agent_infrastructure: CpuChipIcon,
  mlops_community: UsersIcon,
  meme_of_week: FaceSmileIcon,
  ml_confessions: ChatBubbleBottomCenterTextIcon,
  how_we_help: HandRaisedIcon,
  footer: Bars3BottomLeftIcon,
};

function DraggableBlock({ template, onAddBlock }: { template: BlockTemplate; onAddBlock: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `palette-${template.id}`,
    data: {
      type: 'palette-block',
      templateId: template.id,
      template,
    },
  });

  const Icon = BLOCK_ICONS[template.block_type] || DocumentTextIcon;

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.5 : 1,
      }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`
        flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700
        bg-white dark:bg-gray-800 cursor-grab active:cursor-grabbing
        hover:border-primary-300 dark:hover:border-primary-600 hover:shadow-sm
        transition-all duration-150
        ${isDragging ? 'ring-2 ring-primary-500 shadow-lg z-50' : ''}
      `}
      onClick={() => onAddBlock(template.id)}
    >
      <div className="p-2 rounded-md bg-primary-50 dark:bg-primary-900/20">
        <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
          {template.name}
        </p>
        {template.description && (
          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {template.description}
          </p>
        )}
      </div>
      {template.has_bricks && (
        <span className="px-1.5 py-0.5 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded">
          +bricks
        </span>
      )}
    </div>
  );
}

export function BlockPalette({ templates, onAddBlock }: BlockPaletteProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Sort templates by sort_order
  const sortedTemplates = [...templates].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <Card className="sticky top-4">
      <div
        className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700 cursor-pointer"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
          Block Library
        </h3>
        <button className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          {isCollapsed ? (
            <ChevronDownIcon className="w-4 h-4 text-gray-500" />
          ) : (
            <ChevronUpIcon className="w-4 h-4 text-gray-500" />
          )}
        </button>
      </div>

      {!isCollapsed && (
        <div className="p-3 space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Drag blocks to the canvas or click to add
          </p>
          {sortedTemplates.map((template) => (
            <DraggableBlock
              key={template.id}
              template={template}
              onAddBlock={onAddBlock}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

export default BlockPalette;
