import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Card, Input, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { EngagementService, EngagementRule } from '../services/engagementService';

export default function RulesPage() {
  const [rules, setRules] = useState<EngagementRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState<Record<string, Partial<EngagementRule>>>({});

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    const result = await EngagementService.listRules();
    if (result.success && result.data) setRules(result.data);
    setLoading(false);
  }

  function patch(id: string, fields: Partial<EngagementRule>) {
    setDirty((prev) => ({ ...prev, [id]: { ...prev[id], ...fields } }));
  }

  async function save(rule: EngagementRule) {
    const changes = dirty[rule.id];
    if (!changes) return;
    const result = await EngagementService.updateRule(rule.id, changes);
    if (result.success) {
      toast.success('Rule updated');
      setDirty((prev) => {
        const copy = { ...prev };
        delete copy[rule.id];
        return copy;
      });
      await load();
    } else {
      toast.error(result.error || 'Failed to update');
    }
  }

  return (
    <Page title="Scoring rules">
      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--gray-3)] text-[var(--gray-11)] text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Signal</th>
                <th className="text-left px-4 py-3">Label</th>
                <th className="text-left px-4 py-3">Scope</th>
                <th className="text-right px-4 py-3">Points</th>
                <th className="text-right px-4 py-3">Cooldown (s)</th>
                <th className="text-right px-4 py-3">Daily cap</th>
                <th className="text-center px-4 py-3">Enabled</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const d = dirty[rule.id] || {};
                const isDirty = Object.keys(d).length > 0;
                return (
                  <tr key={rule.id} className="border-t border-[var(--gray-6)]">
                    <td className="px-4 py-3 font-mono text-xs">{rule.signal}</td>
                    <td className="px-4 py-3">{rule.label}</td>
                    <td className="px-4 py-3">
                      <Badge color="neutral" className="text-[10px]">{rule.scope.replace('_', ' ')}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        value={d.default_points ?? rule.default_points}
                        onChange={(e) => patch(rule.id, { default_points: parseInt(e.target.value || '0', 10) })}
                        className="w-20 text-right"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        value={d.cooldown_seconds ?? rule.cooldown_seconds ?? 0}
                        onChange={(e) => patch(rule.id, { cooldown_seconds: parseInt(e.target.value || '0', 10) })}
                        className="w-20 text-right"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        value={d.daily_cap ?? rule.daily_cap ?? 0}
                        onChange={(e) => patch(rule.id, { daily_cap: parseInt(e.target.value || '0', 10) || null })}
                        className="w-20 text-right"
                        placeholder="—"
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={d.is_enabled ?? rule.is_enabled}
                        onChange={(e) => patch(rule.id, { is_enabled: e.target.checked })}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {isDirty && (
                        <Button size="sm" onClick={() => save(rule)}>Save</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
