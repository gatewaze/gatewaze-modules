/**
 * Publication "Approval" tab: who must approve an edition before it can be
 * sent. Only super admins can change it (the database function refuses
 * anyone else). With no approvers, editions send as before.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card } from '@/components/ui';
import { approvalService, type ApproverOption } from '../utils/approvalService';

interface Props {
  collectionId: string;
  canEdit: boolean;
}

export function ApprovalSettings({ collectionId, canEdit }: Props) {
  const [options, setOptions] = useState<ApproverOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await approvalService.approverOptions(collectionId);
      setOptions(rows);
      setSelected(new Set(rows.filter((r) => r.is_approver).map((r) => r.user_id)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load approvers');
    } finally {
      setLoading(false);
    }
  }, [collectionId]);
  useEffect(() => { void load(); }, [load]);

  const saved = useMemo(() => new Set(options.filter((o) => o.is_approver).map((o) => o.user_id)), [options]);
  const dirty = saved.size !== selected.size || [...selected].some((id) => !saved.has(id));
  const shown = options.filter((o) => {
    const q = filter.trim().toLowerCase();
    return !q || o.name.toLowerCase().includes(q) || o.email.toLowerCase().includes(q) || selected.has(o.user_id);
  });

  const save = async () => {
    setSaving(true);
    try {
      const n = await approvalService.setApprovers(collectionId, [...selected]);
      toast.success(n === 0 ? 'Approval turned off for this newsletter.' : `${n} approver${n === 1 ? '' : 's'} saved.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save approvers');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <Card className="p-5 space-y-4">
        <div>
          <h3 className="text-base font-semibold text-[var(--gray-12)]">Approvers</h3>
          <p className="text-sm text-[var(--gray-11)] mt-1">
            When this newsletter has approvers, an edition cannot be sent until one of them approves it.
            With no approvers, editions send as they do now.
          </p>
        </div>
        {loading ? (
          <p className="text-sm text-[var(--gray-10)]">Loading…</p>
        ) : (
          <>
            {options.length > 8 && (
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name or email"
                className="w-full px-3 py-2 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm text-[var(--gray-12)]"
              />
            )}
            <ul className="flex flex-col gap-1 max-h-[420px] overflow-auto">
              {shown.map((o) => (
                <li key={o.user_id}>
                  <label className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${canEdit ? 'cursor-pointer hover:bg-[var(--gray-a3)]' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(o.user_id)}
                      disabled={!canEdit || saving}
                      onChange={(e) => setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(o.user_id); else n.delete(o.user_id);
                        return n;
                      })}
                    />
                    <span className="text-sm text-[var(--gray-12)]">{o.name}</span>
                    <span className="text-xs text-[var(--gray-10)]">{o.email}</span>
                    <span className="text-xs text-[var(--gray-9)] ml-auto">{o.role.replace('_', ' ')}</span>
                  </label>
                </li>
              ))}
            </ul>
            {canEdit ? (
              <div className="flex justify-end">
                <Button variant="solid" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save approvers'}</Button>
              </div>
            ) : (
              <p className="text-xs text-[var(--gray-10)]">Only a super admin can change the approvers.</p>
            )}
          </>
        )}
      </Card>
      <Card className="p-5 space-y-2 text-sm text-[var(--gray-11)]">
        <h3 className="text-base font-semibold text-[var(--gray-12)]">How approval works</h3>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>The editor builds the edition, then clicks <strong>Request approval</strong> on its Sending tab. The approvers get an email with a link.</li>
          <li>The link opens a simple view of the edition: the newsletter and its fields, nothing else. The approver can edit the content, then <strong>Approve</strong> or <strong>Ask for changes</strong>.</li>
          <li>The editor is emailed the decision. Once approved, the editor sends it, or a scheduled send goes out at its time.</li>
          <li>Any edit to the content after approval needs approving again.</li>
          <li>An approver cannot approve their own request unless they are a super admin, so only a super admin can be both editor and approver.</li>
        </ol>
      </Card>
    </div>
  );
}
