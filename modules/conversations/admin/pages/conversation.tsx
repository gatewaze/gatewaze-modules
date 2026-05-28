import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  TrashIcon,
  ArrowUturnLeftIcon,
  MapPinIcon,
  ArchiveBoxIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  Button,
  Card,
  Badge,
  Input,
  ConfirmModal,
} from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useAuthContext } from '@/app/contexts/auth/context';
import {
  ConversationsService,
  Conversation,
  ConversationMessage,
} from '../services/conversationsService';

export default function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuthContext();

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(true);
  const [slowmodeInput, setSlowmodeInput] = useState(0);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (!id) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, showDeleted]);

  async function load() {
    if (!id) return;
    setLoading(true);
    const [convResult, msgResult] = await Promise.all([
      ConversationsService.get(id),
      ConversationsService.getMessages(id, { limit: 200, includeDeleted: showDeleted }),
    ]);
    if (!convResult.success || !convResult.data) {
      toast.error(convResult.error || 'Conversation not found');
      navigate('/conversations/all');
      return;
    }
    setConversation(convResult.data);
    setSlowmodeInput(convResult.data.slowmode_seconds);
    if (msgResult.success && msgResult.data) {
      setMessages(msgResult.data.messages);
    }
    setLoading(false);
  }

  async function handleDeleteMessage(messageId: string) {
    if (!user?.id) return;
    const result = await ConversationsService.deleteMessage(messageId, user.id);
    if (result.success) {
      toast.success('Message deleted');
      await load();
    } else {
      toast.error(result.error || 'Failed to delete');
    }
  }

  async function handlePin(messageId: string, currentlyPinned: boolean) {
    const result = await ConversationsService.setPinned(messageId, !currentlyPinned);
    if (result.success) {
      toast.success(currentlyPinned ? 'Unpinned' : 'Pinned');
      await load();
    } else {
      toast.error(result.error || 'Failed');
    }
  }

  async function handleArchiveToggle() {
    if (!conversation) return;
    const result = await ConversationsService.setArchived(conversation.id, !conversation.is_archived);
    if (result.success) {
      toast.success(conversation.is_archived ? 'Restored' : 'Archived');
      await load();
    } else {
      toast.error(result.error || 'Failed');
    }
  }

  async function handleSlowmodeChange() {
    if (!conversation) return;
    const result = await ConversationsService.setSlowmode(conversation.id, slowmodeInput);
    if (result.success) {
      toast.success('Slowmode updated');
      await load();
    } else {
      toast.error(result.error || 'Failed');
    }
  }

  if (loading || !conversation) {
    return (
      <Page title="Conversation">
        <div className="flex justify-center py-12"><LoadingSpinner size="large" /></div>
      </Page>
    );
  }

  return (
    <Page title={conversation.title || 'Conversation'}>
      <div className="space-y-4">
        {/* Header */}
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <button
                onClick={() => navigate('/conversations/all')}
                className="text-xs text-[var(--gray-10)] hover:text-[var(--gray-12)] flex items-center gap-1 mb-2"
              >
                <ArrowLeftIcon className="size-3" />
                Back to all conversations
              </button>
              <div className="flex items-center gap-2 mb-1">
                <Badge color="neutral">{conversation.kind.replace('_', ' ')}</Badge>
                {conversation.is_archived && <Badge color="warning">archived</Badge>}
                {conversation.is_default && <Badge color="info">default</Badge>}
              </div>
              <h1 className="text-2xl font-bold text-[var(--gray-12)]">
                {conversation.title || <span className="italic text-[var(--gray-10)]">untitled</span>}
              </h1>
              {conversation.topic && (
                <p className="text-sm text-[var(--gray-10)] mt-1">{conversation.topic}</p>
              )}
            </div>

            <div className="flex flex-col gap-2 flex-shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={handleArchiveToggle}
              >
                <ArchiveBoxIcon className="size-4 mr-1" />
                {conversation.is_archived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </div>

          {/* Slowmode control */}
          <div className="mt-4 flex items-center gap-3">
            <label className="text-xs text-[var(--gray-11)]">Slowmode (seconds, 0 = off)</label>
            <Input
              type="number"
              min={0}
              max={3600}
              value={slowmodeInput}
              onChange={(e) => setSlowmodeInput(parseInt(e.target.value || '0', 10))}
              className="w-24"
            />
            <Button size="sm" onClick={handleSlowmodeChange} disabled={slowmodeInput === conversation.slowmode_seconds}>
              Update
            </Button>
          </div>
        </Card>

        {/* Message feed */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[var(--gray-12)]">Messages</h2>
            <label className="flex items-center gap-2 text-xs text-[var(--gray-11)]">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => setShowDeleted(e.target.checked)}
              />
              Show deleted
            </label>
          </div>

          {messages.length === 0 ? (
            <p className="text-sm text-[var(--gray-10)] text-center py-8">
              No messages.
            </p>
          ) : (
            <div className="space-y-1">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`group flex items-start gap-3 px-3 py-2 rounded hover:bg-[var(--gray-3)] ${
                    msg.is_deleted ? 'opacity-50' : ''
                  } ${msg.is_pinned ? 'border-l-2 border-[var(--accent-9)] pl-2' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-[var(--gray-10)]">
                        {msg.person_id.slice(0, 8)}…
                      </span>
                      <span className="text-[10px] text-[var(--gray-9)]">
                        {new Date(msg.created_at).toLocaleString()}
                      </span>
                      {msg.is_edited && (
                        <span className="text-[10px] text-[var(--gray-9)] italic">edited</span>
                      )}
                      {msg.is_pinned && (
                        <Badge color="info" className="text-[10px]">pinned</Badge>
                      )}
                      {msg.is_deleted && (
                        <Badge color="error" className="text-[10px]">deleted</Badge>
                      )}
                    </div>
                    <div className="text-sm text-[var(--gray-12)] mt-0.5 whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 flex gap-1 flex-shrink-0">
                    {!msg.is_deleted && (
                      <>
                        <button
                          onClick={() => handlePin(msg.id, msg.is_pinned)}
                          title={msg.is_pinned ? 'Unpin' : 'Pin'}
                          className="p-1 text-[var(--gray-10)] hover:text-[var(--gray-12)]"
                        >
                          <MapPinIcon className="size-4" />
                        </button>
                        <button
                          onClick={() =>
                            setConfirmAction({
                              title: 'Delete message?',
                              message: 'This will hide the message from non-moderators. The original content is kept for 30 days.',
                              onConfirm: async () => handleDeleteMessage(msg.id),
                            })
                          }
                          title="Delete"
                          className="p-1 text-[var(--gray-10)] hover:text-[var(--red-11)]"
                        >
                          <TrashIcon className="size-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {confirmAction && (
        <ConfirmModal
          isOpen
          onClose={() => setConfirmAction(null)}
          onConfirm={async () => {
            await confirmAction.onConfirm();
            setConfirmAction(null);
          }}
          title={confirmAction.title}
          message={confirmAction.message}
        />
      )}
    </Page>
  );
}
