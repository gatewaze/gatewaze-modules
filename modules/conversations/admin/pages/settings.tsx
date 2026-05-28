import { Card } from '@/components/ui';
import { Page } from '@/components/shared/Page';

export default function ConversationsSettingsPage() {
  return (
    <Page title="Conversations settings">
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-2">Brand-wide settings</h2>
        <p className="text-sm text-[var(--gray-10)] mb-4">
          Configure default behaviour for new conversations.
        </p>
        <div className="space-y-4">
          <div className="text-xs text-[var(--gray-10)] italic">
            Settings UI placeholder. Backed by per-brand config in <code>brand_settings.metadata</code>:
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li><code>default_slowmode_seconds</code></li>
              <li><code>default_notification_level</code></li>
              <li><code>dm_policy_default</code></li>
              <li><code>dm_audit_enabled</code> (super-admin only)</li>
              <li><code>notification_retention_days</code></li>
              <li><code>deleted_message_retention_days</code></li>
            </ul>
          </div>
        </div>
      </Card>
    </Page>
  );
}
