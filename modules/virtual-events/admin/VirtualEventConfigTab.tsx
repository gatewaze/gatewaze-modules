import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Button } from '@/components/ui';
import { Input, Select, Switch } from '@/components/ui';
import { toast } from 'sonner';
import {
  ClockIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { TrackConfigPanel } from './TrackConfigPanel';

interface VirtualEventConfigTabProps {
  eventUuid: string;
}

interface LiveEventConfig {
  id?: string;
  event_id: string;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  event_status: 'upcoming' | 'live' | 'ended';
  chat_enabled: boolean;
  chat_slowmode_seconds: number;
  reactions_enabled: boolean;
  questions_enabled: boolean;
  show_replay_after_end: boolean;
  filter_linkedin_urls: boolean;
}

const DEFAULT_CONFIG: Omit<LiveEventConfig, 'event_id'> = {
  scheduled_start_at: null,
  scheduled_end_at: null,
  event_status: 'upcoming',
  chat_enabled: true,
  chat_slowmode_seconds: 0,
  reactions_enabled: true,
  questions_enabled: true,
  show_replay_after_end: true,
  filter_linkedin_urls: true,
};

const STATUS_OPTIONS = [
  { label: 'Upcoming', value: 'upcoming' },
  { label: 'Live', value: 'live' },
  { label: 'Ended', value: 'ended' },
];

function toLocalDatetime(isoString: string | null): string {
  if (!isoString) return '';
  const d = new Date(isoString);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDatetime(localString: string): string | null {
  if (!localString) return null;
  return new Date(localString).toISOString();
}

export default function VirtualEventConfigTab({ eventUuid }: VirtualEventConfigTabProps) {
  const [config, setConfig] = useState<LiveEventConfig>({
    ...DEFAULT_CONFIG,
    event_id: eventUuid,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('live_event_config')
        .select('*')
        .eq('event_id', eventUuid)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        setConfig(data as LiveEventConfig);
      } else {
        setConfig({ ...DEFAULT_CONFIG, event_id: eventUuid });
      }
    } catch (err) {
      console.error('Failed to load virtual event config:', err);
      toast.error('Failed to load virtual event configuration');
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const updateField = <K extends keyof LiveEventConfig>(field: K, value: LiveEventConfig[K]) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setIsDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        event_id: eventUuid,
        scheduled_start_at: config.scheduled_start_at,
        scheduled_end_at: config.scheduled_end_at,
        event_status: config.event_status,
        chat_enabled: config.chat_enabled,
        chat_slowmode_seconds: config.chat_slowmode_seconds,
        reactions_enabled: config.reactions_enabled,
        questions_enabled: config.questions_enabled,
        show_replay_after_end: config.show_replay_after_end,
        filter_linkedin_urls: config.filter_linkedin_urls ?? true,
      };

      const { error } = await supabase
        .from('live_event_config')
        .upsert(payload, { onConflict: 'event_id' });

      if (error) throw error;

      toast.success('Virtual event configuration saved');
      setIsDirty(false);
      await loadConfig();
    } catch (err) {
      console.error('Failed to save config:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Event Timing */}
      <Card>
        <div className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <ClockIcon className="w-5 h-5 text-[var(--accent-9)]" />
            <h3 className="text-lg font-semibold">Event Timing</h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Scheduled Start"
              type="datetime-local"
              value={toLocalDatetime(config.scheduled_start_at)}
              onChange={(e) =>
                updateField('scheduled_start_at', fromLocalDatetime(e.target.value))
              }
            />
            <Input
              label="Scheduled End"
              type="datetime-local"
              value={toLocalDatetime(config.scheduled_end_at)}
              onChange={(e) =>
                updateField('scheduled_end_at', fromLocalDatetime(e.target.value))
              }
            />
          </div>

          <div className="mt-4 max-w-xs">
            <Select
              label="Event Status"
              data={STATUS_OPTIONS}
              value={config.event_status}
              onChange={(e) =>
                updateField('event_status', e.target.value as LiveEventConfig['event_status'])
              }
            />
          </div>
        </div>
      </Card>

      {/* Chat Settings */}
      <Card>
        <div className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <ChatBubbleLeftRightIcon className="w-5 h-5 text-[var(--accent-9)]" />
            <h3 className="text-lg font-semibold">Chat Settings</h3>
          </div>

          <div className="space-y-4">
            <Switch
              label="Enable Chat"
              checked={config.chat_enabled}
              onChange={(e) => updateField('chat_enabled', e.target.checked)}
            />

            <div className="max-w-xs">
              <Input
                label="Slowmode (seconds)"
                type="number"
                min={0}
                max={300}
                value={config.chat_slowmode_seconds}
                onChange={(e) =>
                  updateField('chat_slowmode_seconds', Math.max(0, Math.min(300, parseInt(e.target.value) || 0)))
                }
                disabled={!config.chat_enabled}
              />
              <p className="text-xs text-[var(--gray-11)] mt-1">
                Minimum seconds between messages per user. Set to 0 to disable.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 pt-2">
              <div className="space-y-1">
                <Switch
                  label="Enable Reactions"
                  checked={config.reactions_enabled}
                  onChange={(e) => updateField('reactions_enabled', e.target.checked)}
                  disabled={!config.chat_enabled}
                />
                <p className="text-xs text-[var(--gray-9)] pl-11">Allow viewers to react to messages</p>
              </div>

              <div className="space-y-1">
                <Switch
                  label="Enable Questions"
                  checked={config.questions_enabled}
                  onChange={(e) => updateField('questions_enabled', e.target.checked)}
                  disabled={!config.chat_enabled}
                />
                <p className="text-xs text-[var(--gray-9)] pl-11">Show a Questions tab in the chat</p>
              </div>

              <div className="space-y-1">
                <Switch
                  label="Show Replay After Event Ends"
                  checked={config.show_replay_after_end}
                  onChange={(e) => updateField('show_replay_after_end', e.target.checked)}
                />
                <p className="text-xs text-[var(--gray-9)] pl-11">Show the YouTube replay when the event ends</p>
              </div>

              <div className="space-y-1">
                <Switch
                  label="Filter LinkedIn Profile URLs"
                  checked={config.filter_linkedin_urls}
                  onChange={(e) => updateField('filter_linkedin_urls', e.target.checked)}
                />
                <p className="text-xs text-[var(--gray-9)] pl-11">Auto-delete messages containing LinkedIn profile links</p>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={saving || !isDirty}
          color="primary"
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>

      {/* Track Configuration */}
      <div className="border-t border-[var(--gray-a5)] pt-6">
        <div className="flex items-center gap-2 mb-4">
          <Cog6ToothIcon className="w-5 h-5 text-[var(--accent-9)]" />
          <h3 className="text-lg font-semibold">Tracks / Stages</h3>
        </div>
        <TrackConfigPanel eventUuid={eventUuid} />
      </div>
    </div>
  );
}
