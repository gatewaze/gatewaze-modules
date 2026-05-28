import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Card, Input, Select, Badge, Button } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  ConversationsService,
  Conversation,
  ConversationKind,
} from '../services/conversationsService';

const KIND_OPTIONS: Array<{ value: ConversationKind | 'all'; label: string }> = [
  { value: 'all', label: 'All kinds' },
  { value: 'calendar_channel', label: 'Calendar channels' },
  { value: 'event_channel', label: 'Event channels' },
  { value: 'group_channel', label: 'Group channels' },
  { value: 'admin_channel', label: 'Admin channels' },
  { value: 'dm', label: 'DMs (audit only)' },
];

export default function ConversationsListPage() {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<ConversationKind | 'all'>('all');
  const [includeArchived, setIncludeArchived] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindFilter, includeArchived]);

  async function load() {
    setLoading(true);
    const result = await ConversationsService.list({
      kind: kindFilter,
      include_archived: includeArchived,
      limit: 100,
    });
    if (result.success && result.data) {
      setConversations(result.data.conversations);
    }
    setLoading(false);
  }

  const filtered = conversations.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (c.title || '').toLowerCase().includes(s) ||
      (c.topic || '').toLowerCase().includes(s)
    );
  });

  return (
    <Page title="Conversations">
      <div className="space-y-4">
        <Card className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <Input
                placeholder="Search title or topic"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                prefix={<MagnifyingGlassIcon className="size-4" />}
              />
            </div>
            <Select
              value={kindFilter}
              onChange={(v: any) => setKindFilter(v as ConversationKind | 'all')}
              data={KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <label className="flex items-center gap-2 text-sm text-[var(--gray-11)] whitespace-nowrap">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Include archived
            </label>
          </div>
        </Card>

        <Card className="p-4">
          {loading ? (
            <div className="flex justify-center py-12"><LoadingSpinner /></div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)] text-center py-8">
              No conversations match your filters.
            </p>
          ) : (
            <div className="space-y-2">
              {filtered.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => navigate(`/conversations/${conv.id}`)}
                  className="w-full text-left flex items-center justify-between border border-[var(--gray-6)] rounded-md px-4 py-3 hover:border-[var(--gray-8)] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge color="neutral" className="text-[10px]">
                        {conv.kind.replace('_', ' ')}
                      </Badge>
                      {conv.is_archived && (
                        <Badge color="warning" className="text-[10px]">archived</Badge>
                      )}
                      {conv.is_default && (
                        <Badge color="info" className="text-[10px]">default</Badge>
                      )}
                    </div>
                    <div className="text-sm font-medium text-[var(--gray-12)] mt-1 truncate">
                      {conv.title || <span className="italic text-[var(--gray-10)]">untitled</span>}
                    </div>
                    {conv.topic && (
                      <div className="text-xs text-[var(--gray-10)] truncate">{conv.topic}</div>
                    )}
                  </div>
                  <div className="text-xs text-[var(--gray-10)] flex-shrink-0 ml-4 text-right">
                    {conv.last_message_at ? (
                      <>last message {new Date(conv.last_message_at).toLocaleDateString()}</>
                    ) : (
                      'no messages'
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
