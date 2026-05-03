import { useState, useEffect, useCallback } from 'react';
import {
  EnvelopeIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Badge, Button } from '@/components/ui';
import { Spinner } from '@/components/ui/Spinner';
import { supabase } from '@/lib/supabase';
import type { Person } from '@/utils/peopleService';

interface ListInfo {
  id: string;
  slug: string;
  name: string;
  is_active: boolean;
  default_subscribed: boolean;
}

interface Subscription {
  id: string;
  list_id: string;
  subscribed: boolean;
  subscribed_at?: string;
  unsubscribed_at?: string;
  isDefault?: boolean;
}

interface PersonSubscriptionsProps {
  person: Person;
  personId: string;
}

export default function PersonSubscriptions({ person, personId }: PersonSubscriptionsProps) {
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  const [unsubscribingAll, setUnsubscribingAll] = useState(false);
  const [loading, setLoading] = useState(true);

  const email = person?.email;

  const load = useCallback(async () => {
    if (!email) return;
    try {
      const [listsRes, subsRes] = await Promise.all([
        supabase.from('lists').select('id, slug, name, is_active, default_subscribed').eq('is_active', true).order('name'),
        supabase.from('list_subscriptions').select('id, list_id, subscribed, subscribed_at, unsubscribed_at').eq('email', email.toLowerCase()),
      ]);

      const allLists = listsRes.data || [];
      const realSubs = subsRes.data || [];
      setLists(allLists);

      // Build subscriptions: real ones + synthetic defaults for lists without a record
      const subsByList = new Map(realSubs.map(s => [s.list_id, s]));
      const merged: Subscription[] = [];

      for (const list of allLists) {
        const existing = subsByList.get(list.id);
        if (existing) {
          merged.push(existing);
        } else {
          // Synthetic subscription based on default_subscribed
          merged.push({
            id: `default-${list.id}`,
            list_id: list.id,
            subscribed: list.default_subscribed,
            isDefault: true,
          });
        }
      }

      setSubscriptions(merged);
    } catch {
      // lists table may not exist yet
    } finally {
      setLoading(false);
    }
  }, [email]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (sub: Subscription) => {
    if (!email) return;
    setToggling(sub.list_id);

    try {
      const newSubscribed = !sub.subscribed;

      await supabase
        .from('list_subscriptions')
        .upsert({
          list_id: sub.list_id,
          email: email.toLowerCase(),
          person_id: personId || null,
          subscribed: newSubscribed,
          subscribed_at: newSubscribed ? new Date().toISOString() : (sub.subscribed_at || null),
          unsubscribed_at: newSubscribed ? null : new Date().toISOString(),
          source: 'admin',
        }, { onConflict: 'list_id,email' });

      await load();
      toast.success(newSubscribed ? 'Subscribed' : 'Unsubscribed');
    } catch {
      toast.error('Failed to update subscription');
    } finally {
      setToggling(null);
    }
  };

  const handleUnsubscribeAll = async () => {
    if (!email) return;
    const subscribedCount = subscriptions.filter(s => s.subscribed).length;
    if (subscribedCount === 0) return;

    setUnsubscribingAll(true);
    try {
      const subscribedSubs = subscriptions.filter(s => s.subscribed);
      const results = await Promise.allSettled(
        subscribedSubs.map(sub =>
          supabase.from('list_subscriptions').upsert({
            list_id: sub.list_id,
            email: email.toLowerCase(),
            person_id: personId || null,
            subscribed: false,
            unsubscribed_at: new Date().toISOString(),
            source: 'admin',
          }, { onConflict: 'list_id,email' })
        )
      );

      const failed = results.filter(r => r.status === 'rejected').length;
      await load();

      if (failed === 0) {
        toast.success(`Unsubscribed from ${subscribedSubs.length} list${subscribedSubs.length !== 1 ? 's' : ''}`);
      } else {
        toast.warning(`Unsubscribed from ${subscribedSubs.length - failed} lists, ${failed} failed`);
      }
    } catch {
      toast.error('Failed to unsubscribe');
    } finally {
      setUnsubscribingAll(false);
    }
  };

  if (loading || lists.length === 0) return null;

  const listsMap = new Map(lists.map(l => [l.id, l]));
  const subscribedCount = subscriptions.filter(s => s.subscribed).length;

  return (
    <Card variant="surface" className="mb-6 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <EnvelopeIcon className="w-4 h-4 text-[var(--gray-11)]" />
          <span className="text-sm font-medium text-[var(--gray-11)]">
            Email Subscriptions
          </span>
          <span className="text-xs text-[var(--gray-9)]">(click to toggle)</span>
        </div>
        {subscribedCount > 0 && (
          <Button
            variant="ghost"
            color="red"
            size="1"
            onClick={handleUnsubscribeAll}
            disabled={unsubscribingAll}
          >
            {unsubscribingAll ? 'Unsubscribing...' : 'Unsubscribe All'}
          </Button>
        )}
      </div>

      {/* Subscription Badges */}
      <div className="flex flex-wrap gap-2">
        {subscriptions.map(sub => {
          const list = listsMap.get(sub.list_id);
          if (!list) return null;

          const isToggling = toggling === sub.list_id;
          const displayName = list.name;
          const defaultLabel = sub.isDefault ? ' (default)' : '';

          return (
            <Badge
              key={sub.list_id}
              variant={sub.isDefault ? 'outline' : 'soft'}
              color={sub.subscribed ? 'green' : 'gray'}
              className={`gap-1.5 cursor-pointer hover:opacity-70 transition-opacity ${isToggling ? 'pointer-events-none opacity-50' : ''}`}
              onClick={() => handleToggle(sub)}
            >
              {isToggling ? (
                <Spinner className="w-3.5 h-3.5" />
              ) : sub.subscribed ? (
                <CheckCircleIcon className="w-3.5 h-3.5" />
              ) : (
                <XCircleIcon className="w-3.5 h-3.5" />
              )}
              {displayName}{defaultLabel}
            </Badge>
          );
        })}
      </div>
    </Card>
  );
}
