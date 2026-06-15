import { useState, useEffect, useCallback } from 'react';
import {
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  ArrowPathIcon,
  PaperAirplaneIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Badge, Button } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/lib/supabase';
import type { Person } from '@/utils/peopleService';

type InvitationStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface SlackInvitation {
  id: number;
  email: string;
  status: InvitationStatus;
  error_message: string | null;
  invited_at: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

interface PersonSlackInviteProps {
  person: Person;
  personId: string;
}

const STATUS_META: Record<InvitationStatus, { label: string; color: 'gray' | 'blue' | 'green' | 'red'; Icon: typeof ClockIcon }> = {
  pending: { label: 'Pending', color: 'gray', Icon: ClockIcon },
  processing: { label: 'Processing', color: 'blue', Icon: ArrowPathIcon },
  completed: { label: 'Invited', color: 'green', Icon: CheckCircleIcon },
  failed: { label: 'Failed', color: 'red', Icon: XCircleIcon },
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function PersonSlackInvite({ person }: PersonSlackInviteProps) {
  const email = person?.email;
  const [invitation, setInvitation] = useState<SlackInvitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!email) {
      setLoading(false);
      return;
    }
    try {
      const { data } = await supabase
        .from('integrations_slack_invitation_queue')
        .select('id, email, status, error_message, invited_at, retry_count, created_at, updated_at')
        .eq('email', email.toLowerCase())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setInvitation((data as SlackInvitation) ?? null);
    } catch {
      // Queue table may not exist if the slack module migrations haven't run.
      setInvitation(null);
    } finally {
      setLoading(false);
    }
  }, [email]);

  useEffect(() => {
    load();
  }, [load]);

  const sendInvite = async () => {
    if (!email) return;
    setSending(true);
    try {
      const { error } = await supabase.rpc('integrations_request_slack_invitation', {
        p_email: email.toLowerCase(),
        p_account: 'default',
        p_metadata: { source: 'admin' },
      });
      if (error) throw error;
      toast.success('Slack invitation queued');
      await load();
    } catch {
      toast.error('Failed to queue Slack invitation');
    } finally {
      setSending(false);
    }
  };

  if (!email) return null;

  if (loading) {
    return (
      <Card variant="surface" className="mb-6 p-4">
        <div className="flex items-center gap-2">
          <Spinner />
          <span className="text-sm text-[var(--gray-11)]">Loading Slack status…</span>
        </div>
      </Card>
    );
  }

  const meta = invitation ? STATUS_META[invitation.status] : null;
  const isInFlight = invitation?.status === 'pending' || invitation?.status === 'processing';

  return (
    <Card variant="surface" className="mb-6 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ChatBubbleLeftRightIcon className="w-4 h-4 text-[var(--gray-11)]" />
          <span className="text-sm font-medium text-[var(--gray-11)]">Slack</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="1" onClick={load} disabled={sending} title="Refresh status">
            <ArrowPathIcon className="w-4 h-4" />
          </Button>
          <Button variant="soft" size="1" onClick={sendInvite} disabled={sending || isInFlight}>
            <PaperAirplaneIcon className="w-4 h-4 mr-1" />
            {sending ? 'Sending…' : invitation ? 'Resend invite' : 'Send invite'}
          </Button>
        </div>
      </div>

      {!invitation || !meta ? (
        <p className="text-sm text-[var(--gray-9)]">No Slack invitation has been requested for this person.</p>
      ) : (
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-[var(--gray-9)]">Status</span>
            <span className="inline-flex items-center gap-1">
              <meta.Icon className="w-3.5 h-3.5 text-[var(--gray-11)]" />
              <Badge color={meta.color}>{meta.label}</Badge>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--gray-9)]">Requested</span>
            <span className="text-[var(--gray-11)]">{formatDate(invitation.created_at)}</span>
          </div>
          {invitation.invited_at && (
            <div className="flex justify-between">
              <span className="text-[var(--gray-9)]">Invited</span>
              <span className="text-[var(--gray-11)]">{formatDate(invitation.invited_at)}</span>
            </div>
          )}
          {invitation.retry_count > 0 && (
            <div className="flex justify-between">
              <span className="text-[var(--gray-9)]">Retries</span>
              <span className="text-[var(--gray-11)]">{invitation.retry_count}</span>
            </div>
          )}
          {invitation.status === 'failed' && invitation.error_message && (
            <div className="mt-1 text-xs text-[var(--red-11)]">{invitation.error_message}</div>
          )}
        </div>
      )}
    </Card>
  );
}
