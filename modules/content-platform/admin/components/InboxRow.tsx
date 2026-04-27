import { Badge } from '@/components/ui';
import type { InboxRow as InboxRowData } from '../utils/inboxService';

const STATE_COLOR: Record<string, 'green' | 'amber' | 'gray' | 'red' | 'blue'> = {
  published: 'green',
  pending_review: 'amber',
  auto_suppressed: 'gray',
  rejected: 'red',
  unpublished: 'gray',
  draft: 'blue',
};

const SOURCE_LABEL: Record<string, string> = {
  scraper: 'Scraper',
  ai_discovery: 'AI discovery',
  admin_ui: 'Manual',
  api: 'API',
  mcp: 'MCP',
  user_submission: 'User',
  import: 'Import',
  unknown: 'Unknown',
};

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function InboxRow({
  row,
  selected,
  onToggleSelect,
  onOpenDrawer,
  onSourceFilter,
}: {
  row: InboxRowData;
  selected: boolean;
  onToggleSelect: () => void;
  onOpenDrawer: () => void;
  onSourceFilter: (kind: string) => void;
}) {
  const sourceLabel = SOURCE_LABEL[row.source.kind] ?? row.source.kind;
  return (
    <tr className="border-b border-[var(--gray-a4)] hover:bg-[var(--gray-a3)] cursor-pointer" onClick={onOpenDrawer}>
      <td className="px-3 py-2 w-10" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
        />
      </td>
      <td className="px-3 py-2">
        <Badge variant="soft" color="blue" className="capitalize">{row.content_type}</Badge>
      </td>
      <td className="px-3 py-2 max-w-[420px]">
        <div className="flex items-start gap-3">
          {row.thumbnail_url && (
            <img
              src={row.thumbnail_url}
              alt=""
              className="w-12 h-12 object-cover rounded flex-shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm truncate flex items-center gap-1.5" title={row.title ?? ''}>
              <span className="truncate min-w-0">
                {row.title ?? <span className="text-[var(--gray-10)] italic">untitled</span>}
              </span>
              {row.source_url && (
                <a
                  href={row.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-[var(--gray-10)] hover:text-[var(--accent-9)] flex-shrink-0"
                  title={`Open source: ${row.source_url}`}
                >
                  ↗
                </a>
              )}
            </div>
            {row.subtitle && (
              <div className="text-xs text-[var(--gray-11)] truncate" title={row.subtitle}>
                {row.subtitle}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 max-w-[260px]">
        {row.matched_rules && row.matched_rules.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.matched_rules.slice(0, 3).map((m) => (
              <Badge
                key={m.id}
                variant="soft"
                color={m.kind === 'membership' ? 'green' : 'blue'}
                title={m.name}
              >
                {m.name.length > 28 ? m.name.slice(0, 25) + '…' : m.name}
              </Badge>
            ))}
            {row.matched_rules.length > 3 && (
              <span className="text-xs text-[var(--gray-10)] self-center">
                +{row.matched_rules.length - 3}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-[var(--gray-10)] italic">no match</span>
        )}
      </td>
      <td className="px-3 py-2">
        {row.category && (
          <Badge variant="soft" color={row.category === 'members' ? 'green' : 'gray'}>
            {row.category}
          </Badge>
        )}
      </td>
      <td className="px-3 py-2">
        {row.publish_state && (
          <Badge variant="soft" color={STATE_COLOR[row.publish_state] ?? 'gray'}>
            {row.publish_state.replace(/_/g, ' ')}
          </Badge>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-[var(--gray-11)] whitespace-nowrap">
        {relativeTime(row.submitted_at)}
      </td>
    </tr>
  );
}
