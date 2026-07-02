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
  email: string;
}

interface AliasEmail {
  email: string;
  is_primary: boolean;
  verified: boolean;
  label?: string | null;
}

interface PersonSubscriptionsProps {
  person: Person;
  personId: string;
}

export default function PersonSubscriptions({ person, personId }: PersonSubscriptionsProps) {
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [emails, setEmails] = useState<AliasEmail[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  const [unsubscribingAll, setUnsubscribingAll] = useState(false);
  const [loading, setLoading] = useState(true);

  const primaryEmail = person?.email;

  const load = useCallback(async () => {
    if (!personId && !primaryEmail) return;
    try {
      // The person's owned addresses (primary + any aliases). Each keeps its own
      // subscriptions. Fall back to the profile email if the alias table has no
      // row yet (older data / person_emails not present).
      let owned: AliasEmail[] = [];
      if (personId) {
        const { data } = await supabase
          .from('person_emails')
          .select('email, is_primary, verified, label')
          .eq('person_id', personId)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: true });
        owned = (data as AliasEmail[] | null) || [];
      }
      if (owned.length === 0 && primaryEmail) {
        owned = [{ email: primaryEmail.toLowerCase(), is_primary: true, verified: true }];
      }
      const addrs = owned.map(e => e.email.toLowerCase());

      const [listsRes, subsRes] = await Promise.all([
        supabase.from('lists').select('id, slug, name, is_active, default_subscribed').eq('is_active', true).order('name'),
        addrs.length
          ? supabase.from('list_subscriptions').select('id, list_id, subscribed, subscribed_at, unsubscribed_at, email').in('email', addrs)
          : Promise.resolve({ data: [] as Subscription[] }),
      ]);

      const allLists = listsRes.data || [];
      const realSubs = (subsRes.data || []) as Subscription[];
      setLists(allLists);
      setEmails(owned);

      // Per email: real subscription rows + synthetic defaults for lists with none.
      const byEmailList = new Map<string, Subscription>();
      for (const s of realSubs) byEmailList.set(`${s.email.toLowerCase()}::${s.list_id}`, { ...s, email: s.email.toLowerCase() });

      const merged: Subscription[] = [];
      for (const e of owned) {
        for (const list of allLists) {
          const existing = byEmailList.get(`${e.email.toLowerCase()}::${list.id}`);
          if (existing) {
            merged.push(existing);
          } else {
            merged.push({ id: `default-${e.email}-${list.id}`, list_id: list.id, subscribed: list.default_subscribed, isDefault: true, email: e.email.toLowerCase() });
          }
        }
      }
      setSubscriptions(merged);
    } catch {
      // lists / person_emails table may not exist yet
    } finally {
      setLoading(false);
    }
  }, [personId, primaryEmail]);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (sub: Subscription) => {
    setToggling(`${sub.email}::${sub.list_id}`);
    try {
      const newSubscribed = !sub.subscribed;
      await supabase
        .from('list_subscriptions')
        .upsert({
          list_id: sub.list_id,
          email: sub.email.toLowerCase(),
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

  const [removingAlias, setRemovingAlias] = useState<string | null>(null);
  const handleRemoveAlias = async (e: AliasEmail) => {
    if (e.is_primary) return;
    setRemovingAlias(e.email);
    try {
      // Disown this address's subscriptions, then drop the alias row.
      await supabase.from('list_subscriptions').update({ person_id: null }).eq('email', e.email.toLowerCase()).eq('person_id', personId);
      const { error } = await supabase.from('person_emails').delete().eq('person_id', personId).eq('email', e.email.toLowerCase());
      if (error) throw error;
      await load();
      toast.success(`Removed ${e.email}`);
    } catch {
      toast.error('Failed to remove alias');
    } finally {
      setRemovingAlias(null);
    }
  };

  const handleUnsubscribeAll = async () => {
    const subscribedSubs = subscriptions.filter(s => s.subscribed);
    if (subscribedSubs.length === 0) return;

    setUnsubscribingAll(true);
    try {
      const results = await Promise.allSettled(
        subscribedSubs.map(sub =>
          supabase.from('list_subscriptions').upsert({
            list_id: sub.list_id,
            email: sub.email.toLowerCase(),
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
  const hasAliases = emails.length > 1;

  const renderBadge = (sub: Subscription) => {
    const list = listsMap.get(sub.list_id);
    if (!list) return null;
    const isToggling = toggling === `${sub.email}::${sub.list_id}`;
    const defaultLabel = sub.isDefault ? ' (default)' : '';
    return (
      <Badge
        key={`${sub.email}-${sub.list_id}`}
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
        {list.name}{defaultLabel}
      </Badge>
    );
  };

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

      {hasAliases ? (
        // One row per owned address (each keeps its own subscriptions).
        <div className="flex flex-col gap-3">
          {emails.map(e => (
            <div key={e.email}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium text-[var(--gray-11)]">{e.email}</span>
                {e.is_primary && <Badge variant="soft" color="gray" size="1">Primary</Badge>}
                {e.label && <Badge variant="outline" color="gray" size="1">{e.label}</Badge>}
                {!e.verified && <Badge variant="soft" color="amber" size="1">Unconfirmed</Badge>}
                {!e.is_primary && (
                  <Button
                    variant="ghost"
                    color="red"
                    size="1"
                    className="ml-auto"
                    onClick={() => handleRemoveAlias(e)}
                    disabled={removingAlias === e.email}
                  >
                    {removingAlias === e.email ? 'Removing…' : 'Remove'}
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {subscriptions.filter(s => s.email === e.email.toLowerCase()).map(renderBadge)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // No aliases — the single-address layout as before.
        <div className="flex flex-wrap gap-2">
          {subscriptions.map(renderBadge)}
        </div>
      )}
    </Card>
  );
}
