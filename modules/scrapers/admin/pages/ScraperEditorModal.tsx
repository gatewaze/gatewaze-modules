import React, { useState, useEffect } from 'react';
import { Dialog } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui';
import { Scraper, ScraperService } from '@/utils/scraperService';
import { AccountService } from '@/utils/accountService';
import { useEventTypes } from '@/hooks/useEventTypes';

interface ScraperEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (scraper: Partial<Scraper>) => Promise<void>;
  scraper?: Scraper | null;
}

const SCRAPER_TYPES = [
  'DevEventsConferenceScraper',
  'DevEventsMeetupScraper',
  'LumaEventsScraper',
  'LumaICalScraper'
];

// EVENT_TYPES is now derived dynamically from useEventTypes() + 'mixed'

// Validate cron expression format
function validateCron(cronExpression: string): { valid: boolean; error?: string } {
  if (!cronExpression || cronExpression.trim() === '') {
    return { valid: false, error: 'Cron expression is required' };
  }

  const parts = cronExpression.trim().split(/\s+/);

  // Standard cron: 5 parts (minute hour day month weekday)
  // Extended cron: 6 parts (second minute hour day month weekday)
  if (parts.length !== 5 && parts.length !== 6) {
    return {
      valid: false,
      error: `Invalid format. Expected 5 or 6 parts, got ${parts.length}. Format: minute hour day month weekday`
    };
  }

  // Basic validation of each part (not exhaustive, but catches common errors)
  const validatePart = (part: string, min: number, max: number, name: string): string | null => {
    // Allow wildcards, ranges, steps, lists
    if (part === '*' || part === '?') return null;

    // Handle step values (*/5, 0-23/2)
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      if (isNaN(Number(step)) || Number(step) <= 0) {
        return `${name}: Invalid step value`;
      }
      if (range !== '*' && !range.includes('-') && (isNaN(Number(range)) || Number(range) < min || Number(range) > max)) {
        return `${name}: Range value out of bounds (${min}-${max})`;
      }
      return null;
    }

    // Handle ranges (0-5, 1-12)
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        return `${name}: Invalid range (${min}-${max})`;
      }
      return null;
    }

    // Handle lists (1,2,3,4,5)
    if (part.includes(',')) {
      const values = part.split(',').map(Number);
      if (values.some(v => isNaN(v) || v < min || v > max)) {
        return `${name}: Invalid list values (${min}-${max})`;
      }
      return null;
    }

    // Single value
    const value = Number(part);
    if (isNaN(value) || value < min || value > max) {
      return `${name}: Value out of bounds (${min}-${max})`;
    }

    return null;
  };

  const ranges = parts.length === 6
    ? [
        { min: 0, max: 59, name: 'Second' },
        { min: 0, max: 59, name: 'Minute' },
        { min: 0, max: 23, name: 'Hour' },
        { min: 1, max: 31, name: 'Day' },
        { min: 1, max: 12, name: 'Month' },
        { min: 0, max: 7, name: 'Weekday' }
      ]
    : [
        { min: 0, max: 59, name: 'Minute' },
        { min: 0, max: 23, name: 'Hour' },
        { min: 1, max: 31, name: 'Day' },
        { min: 1, max: 12, name: 'Month' },
        { min: 0, max: 7, name: 'Weekday' }
      ];

  for (let i = 0; i < parts.length; i++) {
    const error = validatePart(parts[i], ranges[i].min, ranges[i].max, ranges[i].name);
    if (error) {
      return { valid: false, error };
    }
  }

  return { valid: true };
}

export function ScraperEditorModal({ isOpen, onClose, onSave, scraper }: ScraperEditorModalProps) {
  const { eventTypes } = useEventTypes();
  const EVENT_TYPES = [...eventTypes.map((t) => t.value), 'mixed'];
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    scraper_type: '',
    object_type: 'events' as 'events' | 'jobs',
    event_type: '',
    base_url: '',
    enabled: false,
    timezone: 'UTC',
    account: '',
    config: '{}',
    schedule_enabled: false,
    schedule_frequency: 'none' as 'none' | '5min' | 'hourly' | 'daily' | 'weekly' | 'custom',
    schedule_time: '09:00',
    schedule_days: [] as number[],
    schedule_cron: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [cronError, setCronError] = useState('');
  const [availableAccounts, setAvailableAccounts] = useState<Array<{ name: string; id: string }>>([]);

  // Load available accounts from accounts table
  useEffect(() => {
    const loadAccounts = async () => {
      const { accounts } = await AccountService.getActiveAccounts();
      if (accounts) {
        setAvailableAccounts(accounts.map(a => ({ name: a.name, id: a.id })));
      }
    };
    loadAccounts();
  }, [isOpen]);

  useEffect(() => {
    if (scraper) {
      setFormData({
        name: scraper.name || '',
        description: scraper.description || '',
        scraper_type: scraper.scraper_type || '',
        object_type: scraper.object_type || 'events',
        event_type: scraper.event_type || '',
        base_url: scraper.base_url || '',
        enabled: scraper.enabled || false,
        timezone: (scraper.config as any)?.timezone || 'UTC',
        account: (scraper as any).account || '',
        config: JSON.stringify(scraper.config || {}, null, 2),
        schedule_enabled: scraper.schedule_enabled || false,
        schedule_frequency: scraper.schedule_frequency || 'none',
        schedule_time: scraper.schedule_time || '09:00',
        schedule_days: scraper.schedule_days || [],
        schedule_cron: scraper.schedule_cron || ''
      });
    } else {
      setFormData({
        name: '',
        description: '',
        scraper_type: '',
        object_type: 'events',
        event_type: '',
        base_url: '',
        enabled: false,
        timezone: 'UTC',
        account: '',
        config: '{}',
        schedule_enabled: false,
        schedule_frequency: 'none',
        schedule_time: '09:00',
        schedule_days: [],
        schedule_cron: ''
      });
    }
    setError('');
  }, [scraper, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    try {
      // Validate cron expression if custom is selected
      if (formData.schedule_enabled && formData.schedule_frequency === 'custom') {
        const validation = validateCron(formData.schedule_cron);
        if (!validation.valid) {
          setError(validation.error || 'Invalid cron expression');
          setCronError(validation.error || 'Invalid cron expression');
          setSaving(false);
          return;
        }
      }

      // Parse config JSON
      let config = {};
      try {
        config = JSON.parse(formData.config);
      } catch (err) {
        setError('Invalid JSON in configuration');
        setSaving(false);
        return;
      }

      const scraperData: Partial<Scraper> = {
        name: formData.name,
        description: formData.description,
        scraper_type: formData.scraper_type,
        object_type: formData.object_type,
        event_type: formData.event_type,
        base_url: formData.base_url,
        enabled: formData.enabled,
        account: formData.account || undefined,
        config: {
          ...config,
          timezone: formData.timezone,
          account: formData.account || undefined
        },
        schedule_enabled: formData.schedule_enabled,
        schedule_frequency: formData.schedule_frequency,
        schedule_time: formData.schedule_time,
        schedule_days: formData.schedule_days.length > 0 ? formData.schedule_days : undefined,
        schedule_cron: formData.schedule_cron || undefined
      };

      await onSave(scraperData);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save scraper');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} className="relative z-50">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />

      <div className="fixed inset-0 flex items-center justify-center p-4 overflow-y-auto">
        <Dialog.Panel className="mx-auto max-w-5xl w-full bg-white dark:bg-neutral-800 rounded-xl shadow-xl my-8">
          <div className="flex items-center justify-between p-6 border-b border-neutral-200 dark:border-neutral-700">
            <Dialog.Title className="text-lg font-semibold text-neutral-900 dark:text-white">
              {scraper ? 'Edit Scraper' : 'Create New Scraper'}
            </Dialog.Title>
            <Button isIcon variant="ghost" onClick={onClose}>
              <XMarkIcon className="size-6" />
            </Button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col max-h-[calc(100vh-8rem)]">
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm col-span-2">
                  {error}
                </div>
              )}

              {/* Two column layout */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Left Column - Basic Info */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-white uppercase tracking-wide">Basic Information</h3>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      Scraper Name *
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      Description
                    </label>
                    <textarea
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      rows={2}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      Object Type *
                    </label>
                    <select
                      required
                      value={formData.object_type}
                      onChange={(e) => setFormData({ ...formData, object_type: e.target.value as 'events' | 'jobs' })}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    >
                      <option value="events">Events</option>
                      <option value="jobs">Jobs</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      Scraper Type *
                    </label>
                    <select
                      required
                      value={formData.scraper_type}
                      onChange={(e) => setFormData({ ...formData, scraper_type: e.target.value })}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    >
                      <option value="">Select...</option>
                      {SCRAPER_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {formData.object_type === 'events' ? 'Event Type *' : 'Category *'}
                    </label>
                    <select
                      required
                      value={formData.event_type}
                      onChange={(e) => setFormData({ ...formData, event_type: e.target.value })}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    >
                      <option value="">Select...</option>
                      {EVENT_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      Base URL *
                    </label>
                    <input
                      type="url"
                      required
                      value={formData.base_url}
                      onChange={(e) => setFormData({ ...formData, base_url: e.target.value })}
                      placeholder="https://example.com"
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        Timezone
                      </label>
                      <input
                        type="text"
                        value={formData.timezone}
                        onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                        placeholder="UTC"
                        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        Account
                        <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">(Optional)</span>
                      </label>
                      <select
                        value={formData.account}
                        onChange={(e) => setFormData({ ...formData, account: e.target.value })}
                        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      >
                        <option value="">None</option>
                        {availableAccounts.map((account) => (
                          <option key={account.id} value={account.name}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="enabled"
                      checked={formData.enabled}
                      onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                      className="size-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
                    />
                    <label htmlFor="enabled" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Enable scraper
                    </label>
                  </div>
                </div>

                {/* Right Column - Scheduling & Configuration */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-white uppercase tracking-wide">Configuration</h3>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      Configuration (JSON)
                    </label>
                    <textarea
                      value={formData.config}
                      onChange={(e) => setFormData({ ...formData, config: e.target.value })}
                      rows={6}
                      placeholder='{"key": "value"}'
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                  </div>

                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-white uppercase tracking-wide mt-6">Scheduling</h3>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="schedule_enabled"
                      checked={formData.schedule_enabled}
                      onChange={(e) => setFormData({ ...formData, schedule_enabled: e.target.checked })}
                      className="size-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
                    />
                    <label htmlFor="schedule_enabled" className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Enable automatic scheduling
                    </label>
                  </div>

                  {formData.schedule_enabled && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                          Frequency *
                        </label>
                        <select
                          value={formData.schedule_frequency}
                          onChange={(e) => setFormData({ ...formData, schedule_frequency: e.target.value as any })}
                          className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        >
                          <option value="none">Manual only (no schedule)</option>
                          <option value="5min">Every 5 minutes</option>
                          <option value="hourly">Hourly</option>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="custom">Custom (cron expression)</option>
                        </select>
                      </div>

                      {formData.schedule_frequency === 'daily' && (
                        <div>
                          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                            Time of day
                          </label>
                          <input
                            type="time"
                            value={formData.schedule_time}
                            onChange={(e) => setFormData({ ...formData, schedule_time: e.target.value })}
                            className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          />
                        </div>
                      )}

                      {formData.schedule_frequency === 'weekly' && (
                        <>
                          <div>
                            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                              Time of day
                            </label>
                            <input
                              type="time"
                              value={formData.schedule_time}
                              onChange={(e) => setFormData({ ...formData, schedule_time: e.target.value })}
                              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                              Days of week
                            </label>
                            <div className="flex gap-2 flex-wrap">
                              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => (
                                <label key={index} className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    checked={formData.schedule_days.includes(index)}
                                    onChange={(e) => {
                                      const days = e.target.checked
                                        ? [...formData.schedule_days, index]
                                        : formData.schedule_days.filter(d => d !== index);
                                      setFormData({ ...formData, schedule_days: days.sort() });
                                    }}
                                    className="size-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
                                  />
                                  <span className="text-sm text-neutral-700 dark:text-neutral-300">{day}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {formData.schedule_frequency === 'custom' && (
                        <div>
                          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                            Cron expression
                          </label>
                          <input
                            type="text"
                            value={formData.schedule_cron}
                            onChange={(e) => {
                              const value = e.target.value;
                              setFormData({ ...formData, schedule_cron: value });

                              // Validate cron expression
                              if (value.trim()) {
                                const validation = validateCron(value);
                                setCronError(validation.valid ? '' : validation.error || 'Invalid cron expression');
                              } else {
                                setCronError('');
                              }
                            }}
                            onBlur={() => {
                              // Validate on blur if custom is selected
                              if (formData.schedule_cron.trim()) {
                                const validation = validateCron(formData.schedule_cron);
                                setCronError(validation.valid ? '' : validation.error || 'Invalid cron expression');
                              }
                            }}
                            placeholder="*/5 * * * *"
                            className={`w-full px-3 py-2 border rounded-lg bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white font-mono text-sm focus:ring-2 focus:ring-primary-500 focus:border-transparent ${
                              cronError ? 'border-red-500 dark:border-red-500' : 'border-neutral-300 dark:border-neutral-600'
                            }`}
                          />
                          {cronError && (
                            <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                              {cronError}
                            </p>
                          )}
                          <p className="text-xs text-neutral-500 mt-1">
                            Format: minute hour day month weekday. <a href="https://crontab.guru" target="_blank" rel="noopener noreferrer" className="underline">Help</a>
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer with buttons */}
            <div className="border-t border-neutral-200 dark:border-neutral-700 p-6 flex justify-end gap-3">
              <Button variant="outlined" onClick={onClose} type="button">
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : scraper ? 'Update Scraper' : 'Create Scraper'}
              </Button>
            </div>
          </form>
        </Dialog.Panel>
      </div>
    </Dialog>
  );
}
