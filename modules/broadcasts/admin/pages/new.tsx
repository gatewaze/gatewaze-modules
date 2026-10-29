import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Card, Button, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { createBroadcast, type BroadcastChannel } from '../lib/broadcastService';

const CHANNELS: { id: BroadcastChannel; label: string; help: string }[] = [
  { id: 'email', label: 'Email', help: 'An email to the people in a segment who subscribe to the list you choose.' },
  { id: 'slack', label: 'Slack message', help: 'A direct message in Slack to the people in a segment who are members of the workspace.' },
];

export default function NewBroadcastPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [channel, setChannel] = useState<BroadcastChannel>('email');
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!name.trim()) { toast.error('Give the broadcast a name'); return; }
    setCreating(true);
    try {
      const c = await createBroadcast({
        name: name.trim(),
        channel,
        subject: channel === 'email' ? subject.trim() || undefined : undefined,
      });
      navigate(`/broadcasts/${c.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create broadcast');
      setCreating(false);
    }
  }

  return (
    <Page title="New Broadcast">
      <WorkspaceLayout title="Broadcasts: New">
        <Card className="p-6 max-w-xl space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Broadcast name</label>
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
            <span className="block text-sm font-medium text-[var(--gray-12)] mb-1">Send as</span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Channel">
              {CHANNELS.map((c) => (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${channel === c.id ? 'border-[var(--accent-9)] bg-[var(--accent-a2)]' : 'border-[var(--gray-6)]'}`}
                >
                  <input type="radio" name="channel" className="mt-0.5" checked={channel === c.id} onChange={() => setChannel(c.id)} />
                  <span>
                    <span className="block font-medium text-[var(--gray-12)]">{c.label}</span>
                    <span className="block text-xs text-[var(--gray-10)] mt-0.5">{c.help}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-[var(--gray-10)] mt-1">This can&apos;t be changed after the broadcast is created.</p>
          </div>
          {channel === 'email' && (
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Subject (optional)</label>
              <input
                className="w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="What recipients see in their inbox"
              />
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="soft" onClick={() => navigate('/broadcasts')}>Cancel</Button>
            <Button variant="solid" onClick={create} disabled={creating}>{creating ? 'Creating…' : 'Create & continue'}</Button>
          </div>
        </Card>
      </WorkspaceLayout>
    </Page>
  );
}
