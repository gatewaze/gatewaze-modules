import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Card, Badge } from '@/components/ui';
import { PlusIcon, TrashIcon, BellIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

interface ReminderConfig {
  id: string;
  event_id: string;
  days_before_deadline: number;
  template_id: string | null;
  sms_template: string | null;
  enabled: boolean;
  created_at: string;
}

interface ReminderLog {
  id: string;
  reminder_config_id: string;
  party_id: string;
  sent_at: string;
  delivery_channel: string;
}

interface ReminderConfigPanelProps {
  eventUuid: string;
}

export function ReminderConfigPanel({ eventUuid }: ReminderConfigPanelProps) {
  const [configs, setConfigs] = useState<ReminderConfig[]>([]);
  const [logs, setLogs] = useState<ReminderLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [daysInput, setDaysInput] = useState(7);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: configData } = await supabase
        .from('invite_reminder_config')
        .select('*')
        .eq('event_id', eventUuid)
        .order('days_before_deadline');

      setConfigs(configData || []);

      if (configData && configData.length > 0) {
        const configIds = configData.map(c => c.id);
        const { data: logData } = await supabase
          .from('invite_reminder_log')
          .select('*')
          .in('reminder_config_id', configIds)
          .order('sent_at', { ascending: false })
          .limit(50);

        setLogs(logData || []);
      }
    } catch (error) {
      console.error('Error loading reminder config:', error);
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAdd = async () => {
    if (daysInput < 1) {
      toast.error('Days must be at least 1');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from('invite_reminder_config')
        .insert({
          event_id: eventUuid,
          days_before_deadline: daysInput,
          enabled: true,
        });

      if (error) {
        if (error.code === '23505') {
          toast.error(`A reminder for ${daysInput} days before deadline already exists`);
        } else {
          throw error;
        }
      } else {
        toast.success(`Reminder added: ${daysInput} days before deadline`);
        setShowAdd(false);
        setDaysInput(7);
        loadData();
      }
    } catch (error) {
      console.error('Error adding reminder:', error);
      toast.error('Failed to add reminder');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    const { error } = await supabase
      .from('invite_reminder_config')
      .update({ enabled: !enabled })
      .eq('id', id);

    if (error) {
      toast.error('Failed to update reminder');
    } else {
      loadData();
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase
      .from('invite_reminder_config')
      .delete()
      .eq('id', id);

    if (error) {
      toast.error('Failed to delete reminder');
    } else {
      toast.success('Reminder deleted');
      loadData();
    }
  };

  const getLogCount = (configId: string) => {
    return logs.filter(l => l.reminder_config_id === configId).length;
  };

  if (loading) {
    return <p className="text-sm text-[var(--gray-9)]">Loading reminders...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">
          <BellIcon className="w-4 h-4 inline mr-1" />
          RSVP Reminders
        </h3>
        <Button variant="soft" size="1" onClick={() => setShowAdd(!showAdd)}>
          <PlusIcon className="w-4 h-4 mr-1" />
          Add Rule
        </Button>
      </div>

      {showAdd && (
        <Card className="p-3">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-[var(--gray-11)] mb-1">
                Send reminder this many days before the RSVP deadline
              </label>
              <input
                type="number"
                min={1}
                max={90}
                value={daysInput}
                onChange={e => setDaysInput(parseInt(e.target.value) || 1)}
                className="w-24 px-3 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="soft" size="1" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button size="1" onClick={handleAdd} disabled={saving}>
                {saving ? 'Adding...' : 'Add'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {configs.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-[var(--gray-9)] text-center">
            No reminder rules configured. Add a rule to automatically remind parties that haven't responded.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {configs.map(c => (
            <Card key={c.id} className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleToggle(c.id, c.enabled)}
                    className={`w-8 h-4 rounded-full relative cursor-pointer transition-colors ${
                      c.enabled ? 'bg-[var(--accent-9)]' : 'bg-[var(--gray-6)]'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                        c.enabled ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <div>
                    <p className="text-sm font-medium text-[var(--gray-12)]">
                      {c.days_before_deadline} day{c.days_before_deadline !== 1 ? 's' : ''} before deadline
                    </p>
                    <p className="text-xs text-[var(--gray-9)]">
                      {getLogCount(c.id)} reminders sent
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(c.id)}
                  className="text-[var(--gray-9)] hover:text-red-600 cursor-pointer"
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
