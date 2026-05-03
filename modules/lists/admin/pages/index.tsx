import { useState, useEffect, useCallback } from 'react';
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  UsersIcon,
  GlobeAltIcon,
  LockClosedIcon,
  ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge, Modal } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { ListService } from '../utils/listService';
import type { List, ListSubscription } from '../../types';

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export default function ListsPage() {
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingList, setEditingList] = useState<List | null>(null);
  const [showSubscribers, setShowSubscribers] = useState<string | null>(null);
  const [subscribers, setSubscribers] = useState<ListSubscription[]>([]);
  const [subscribersLoading, setSubscribersLoading] = useState(false);
  const [showImportModal, setShowImportModal] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [saving, setSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    description: '',
    is_active: true,
    is_public: true,
    default_subscribed: false,
    webhook_url: '',
    webhook_secret: '',
    webhook_events: [] as string[],
  });

  const loadLists = useCallback(async () => {
    setLoading(true);
    const { data, error } = await ListService.getAll();
    if (error) toast.error('Failed to load lists');
    setLists(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadLists(); }, [loadLists]);

  const openCreate = () => {
    setEditingList(null);
    setFormData({
      name: '', slug: '', description: '', is_active: true,
      is_public: true, default_subscribed: false,
      webhook_url: '', webhook_secret: '', webhook_events: [],
    });
    setShowModal(true);
  };

  const openEdit = (list: List) => {
    setEditingList(list);
    setFormData({
      name: list.name,
      slug: list.slug,
      description: list.description || '',
      is_active: list.is_active,
      is_public: list.is_public,
      default_subscribed: list.default_subscribed,
      webhook_url: list.webhook_url || '',
      webhook_secret: list.webhook_secret || '',
      webhook_events: list.webhook_events || [],
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!formData.name || !formData.slug) {
      toast.error('Name and slug are required');
      return;
    }
    setSaving(true);
    try {
      if (editingList) {
        const { error } = await ListService.update(editingList.id, formData);
        if (error) throw error;
        toast.success('List updated');
      } else {
        const { error } = await ListService.create(formData);
        if (error) throw error;
        toast.success('List created');
      }
      setShowModal(false);
      await loadLists();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (list: List) => {
    if (!confirm(`Delete "${list.name}"? This will remove all subscriptions.`)) return;
    const { error } = await ListService.delete(list.id);
    if (error) toast.error('Failed to delete');
    else { toast.success('List deleted'); await loadLists(); }
  };

  const loadSubscribers = async (listId: string) => {
    setSubscribersLoading(true);
    setShowSubscribers(listId);
    const { data } = await ListService.getSubscribers(listId);
    setSubscribers(data || []);
    setSubscribersLoading(false);
  };

  const handleImport = async () => {
    if (!showImportModal || !importText.trim()) return;
    const emails = importText.split('\n').map(e => e.trim()).filter(Boolean);
    const { count, error } = await ListService.importSubscribers(showImportModal, emails);
    if (error) toast.error('Import failed');
    else { toast.success(`Imported ${count} subscribers`); setShowImportModal(null); setImportText(''); }
  };

  const toggleWebhookEvent = (event: string) => {
    setFormData(prev => ({
      ...prev,
      webhook_events: prev.webhook_events.includes(event)
        ? prev.webhook_events.filter(e => e !== event)
        : [...prev.webhook_events, event],
    }));
  };

  return (
    <Page title="Lists">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Subscription Lists</h1>
            <p className="text-[var(--gray-11)] mt-1">Manage mailing lists and subscriber preferences</p>
          </div>
          <Button variant="solid" onClick={openCreate}>
            <PlusIcon className="h-4 w-4 mr-1" /> Create List
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
          </div>
        ) : lists.length === 0 ? (
          <Card className="p-8 text-center">
            <UsersIcon className="h-12 w-12 text-[var(--gray-8)] mx-auto mb-3" />
            <p className="text-[var(--gray-11)]">No lists yet. Create your first subscription list.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {lists.map(list => (
              <Card key={list.id} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-[var(--gray-12)]">{list.name}</h3>
                      <Badge variant="soft" color={list.is_active ? 'green' : 'gray'}>
                        {list.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                      {list.is_public ? (
                        <GlobeAltIcon className="h-4 w-4 text-[var(--gray-9)]" title="Public" />
                      ) : (
                        <LockClosedIcon className="h-4 w-4 text-[var(--gray-9)]" title="Private" />
                      )}
                      {list.webhook_url && (
                        <Badge variant="soft" color="blue">Webhook</Badge>
                      )}
                    </div>
                    <p className="text-sm text-[var(--gray-9)] mt-0.5">
                      {list.slug} · {list.subscriber_count || 0} subscriber{list.subscriber_count !== 1 ? 's' : ''}
                      {list.description && ` · ${list.description}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={() => loadSubscribers(list.id)} title="View subscribers">
                      <UsersIcon className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" onClick={() => { setShowImportModal(list.id); setImportText(''); }} title="Import">
                      <ArrowUpTrayIcon className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" onClick={() => openEdit(list)} title="Edit">
                      <PencilIcon className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" onClick={() => handleDelete(list)} title="Delete">
                      <TrashIcon className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* Create/Edit Modal */}
        <Modal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          title={editingList ? 'Edit List' : 'Create List'}
          size="lg"
          footer={
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button variant="solid" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editingList ? 'Update' : 'Create'}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Name *</label>
                <input
                  value={formData.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    setFormData(prev => ({
                      ...prev,
                      name,
                      slug: editingList ? prev.slug : slugify(name),
                    }));
                  }}
                  className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm"
                  placeholder="AAIF Newsletter"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Slug *</label>
                <input
                  value={formData.slug}
                  onChange={(e) => setFormData(prev => ({ ...prev, slug: slugify(e.target.value) }))}
                  className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm font-mono"
                  placeholder="aaif-newsletter"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={2}
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm"
                placeholder="Weekly updates from the AAIF community"
              />
            </div>

            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={formData.is_active} onChange={(e) => setFormData(prev => ({ ...prev, is_active: e.target.checked }))} className="rounded" />
                Active
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={formData.is_public} onChange={(e) => setFormData(prev => ({ ...prev, is_public: e.target.checked }))} className="rounded" />
                Public (visible on portal)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={formData.default_subscribed} onChange={(e) => setFormData(prev => ({ ...prev, default_subscribed: e.target.checked }))} className="rounded" />
                Subscribe by default
              </label>
            </div>

            <hr className="border-[var(--gray-a5)]" />

            <div>
              <h4 className="text-sm font-medium text-[var(--gray-12)] mb-3">Webhook Configuration</h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-[var(--gray-11)] mb-1">Webhook URL</label>
                  <input
                    value={formData.webhook_url}
                    onChange={(e) => setFormData(prev => ({ ...prev, webhook_url: e.target.value }))}
                    className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm"
                    placeholder="https://example.com/webhook"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--gray-11)] mb-1">Webhook Secret</label>
                  <input
                    type="password"
                    value={formData.webhook_secret}
                    onChange={(e) => setFormData(prev => ({ ...prev, webhook_secret: e.target.value }))}
                    className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm font-mono"
                    placeholder="HMAC signing secret"
                  />
                </div>
                {editingList?.api_key && (
                  <div>
                    <label className="block text-sm text-[var(--gray-11)] mb-1">API Key (for external systems)</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={editingList.api_key}
                        className="flex-1 px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--gray-a2)] text-sm font-mono"
                      />
                      <Button variant="outline" onClick={() => {
                        navigator.clipboard.writeText(editingList.api_key!);
                        toast.success('API key copied');
                      }}>Copy</Button>
                    </div>
                    <p className="text-xs text-[var(--gray-9)] mt-1">
                      External systems use this key in the X-Api-Key header to subscribe/unsubscribe via the API.
                    </p>
                  </div>
                )}
                <div>
                  <label className="block text-sm text-[var(--gray-11)] mb-1">Trigger on events</label>
                  <div className="flex items-center gap-4">
                    {['subscribe', 'unsubscribe'].map(event => (
                      <label key={event} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={formData.webhook_events.includes(event)}
                          onChange={() => toggleWebhookEvent(event)}
                          className="rounded"
                        />
                        {event.charAt(0).toUpperCase() + event.slice(1)}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Modal>

        {/* Subscribers Modal */}
        <Modal
          isOpen={!!showSubscribers}
          onClose={() => setShowSubscribers(null)}
          title={`Subscribers — ${lists.find(l => l.id === showSubscribers)?.name || ''}`}
          size="lg"
          footer={
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => setShowSubscribers(null)}>Close</Button>
            </div>
          }
        >
          {subscribersLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" />
            </div>
          ) : subscribers.length === 0 ? (
            <p className="text-center text-[var(--gray-9)] py-8">No subscribers yet</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-[var(--gray-9)] border-b border-[var(--gray-a5)]">
                  <tr>
                    <th className="text-left py-2">Email</th>
                    <th className="text-left py-2">Status</th>
                    <th className="text-left py-2">Source</th>
                    <th className="text-left py-2">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--gray-a4)]">
                  {subscribers.map(sub => (
                    <tr key={sub.id}>
                      <td className="py-2 text-[var(--gray-12)]">{sub.email}</td>
                      <td className="py-2">
                        <Badge variant="soft" color={sub.subscribed ? 'green' : 'gray'}>
                          {sub.subscribed ? 'Subscribed' : 'Unsubscribed'}
                        </Badge>
                      </td>
                      <td className="py-2 text-[var(--gray-9)]">{sub.source}</td>
                      <td className="py-2 text-[var(--gray-9)]">
                        {new Date(sub.subscribed_at || sub.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>

        {/* Import Modal */}
        <Modal
          isOpen={!!showImportModal}
          onClose={() => setShowImportModal(null)}
          title="Import Subscribers"
          size="md"
          footer={
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setShowImportModal(null)}>Cancel</Button>
              <Button variant="solid" onClick={handleImport} disabled={!importText.trim()}>
                Import {importText.trim() ? importText.split('\n').filter(Boolean).length : 0} emails
              </Button>
            </div>
          }
        >
          <div>
            <p className="text-sm text-[var(--gray-9)] mb-3">Paste one email per line.</p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm font-mono"
              placeholder="user1@example.com&#10;user2@example.com"
            />
          </div>
        </Modal>
      </div>
    </Page>
  );
}
