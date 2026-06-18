import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Card, Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { createCampaign } from '../lib/campaignService';

export default function NewCampaignPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!name.trim()) { toast.error('Give the campaign a name'); return; }
    setCreating(true);
    try {
      const c = await createCampaign({ name: name.trim(), subject: subject.trim() || undefined });
      navigate(`/campaigns/${c.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create campaign');
      setCreating(false);
    }
  }

  return (
    <Page title="New Campaign">
      <WorkspaceLayout title="Campaigns: New">
        <Card className="p-6 max-w-xl space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Campaign name</label>
            <input
              className="w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. June product update"
              autoFocus
            />
            <p className="text-xs text-[var(--gray-10)] mt-1">Internal label — recipients never see this.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Subject (optional)</label>
            <input
              className="w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What recipients see in their inbox"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="soft" onClick={() => navigate('/campaigns')}>Cancel</Button>
            <Button variant="solid" onClick={create} disabled={creating}>{creating ? 'Creating…' : 'Create & continue'}</Button>
          </div>
        </Card>
      </WorkspaceLayout>
    </Page>
  );
}
