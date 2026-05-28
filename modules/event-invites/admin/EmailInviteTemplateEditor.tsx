import { useState, forwardRef, useImperativeHandle } from 'react';
import { Button } from '@/components/ui';
import RichTextEditor from '@/components/ui/RichTextEditor';
import { toast } from 'sonner';
import { createTemplate, updateTemplate, type InviteTemplate } from './utils/inviteTemplateService';
import { getAvailableVariables, replaceVariables, buildInviteContext } from './utils/inviteVariables';
import type { TemplateEditorHandle } from './utils/templateEditorHandle';

interface Props {
  eventUuid: string;
  template: InviteTemplate | null;
  subEventId: string | null;
  onSave: () => void;
}

const SAMPLE_CONTEXT = buildInviteContext(
  { name: 'The Smiths', short_code: 'sb7gcr', members: [
    { first_name: 'Dan', last_name: 'Baker', email: 'dan@example.com', is_lead_booker: true },
    { first_name: 'Sarah', last_name: 'Swift', email: null, is_lead_booker: false },
  ]},
  { event_title: 'Baker-Swift Wedding', event_start: '2026-06-15T14:30:00Z', event_location: "St Mary's Church" },
  { name: 'Day Ceremony', description: 'Join us for the wedding ceremony', starts_at: '2026-06-15T14:30:00Z' },
  'https://example.com',
);

// Build template variable config for RichTextEditor
const inviteVariableGroups = (() => {
  const vars = getAvailableVariables();
  const groups: Record<string, Array<{ label: string; value: string }>> = {};
  for (const v of vars) {
    const [scope] = v.variable.split('.');
    const groupName = scope.charAt(0).toUpperCase() + scope.slice(1);
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push({ label: v.description, value: `{{${v.variable}}}` });
  }
  return Object.entries(groups).map(([name, variables]) => ({ name, variables }));
})();

const EmailInviteTemplateEditor = forwardRef<TemplateEditorHandle, Props>(function EmailInviteTemplateEditor(
  { eventUuid, template, subEventId, onSave }: Props,
  ref,
) {
  const [name, setName] = useState(template?.name || '');
  const [subject, setSubject] = useState(template?.subject || '');
  const [body, setBody] = useState(template?.body || '');
  const [showPreview, setShowPreview] = useState(false);

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!name.trim()) { toast.error('Name is required'); throw new Error('Name is required'); }
      if (!subject.trim()) { toast.error('Subject is required'); throw new Error('Subject is required'); }
      const data = {
        event_id: eventUuid,
        sub_event_id: subEventId,
        channel: 'email' as const,
        name: name.trim(),
        subject: subject.trim(),
        body: body.trim(),
      };
      if (template?.id) await updateTemplate(template.id, data);
      else await createTemplate(data);
      toast.success('Email template saved');
      onSave();
    },
  }), [name, subject, body, eventUuid, subEventId, template?.id, onSave]);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Template Name</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Day Ceremony Email"
          className="w-full px-3 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Subject Line</label>
        <input type="text" value={subject} onChange={e => setSubject(e.target.value)} placeholder="You're invited: {{event.title}}"
          className="w-full px-3 py-1.5 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]" />
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Body</label>
        <RichTextEditor
          content={body}
          onChange={setBody}
          placeholder="Dear {{lead.first_name}}, you're invited to..."
          templateVariables={{ groups: inviteVariableGroups }}
        />
      </div>

      {/* Preview */}
      <div>
        <Button variant="soft" size="1" onClick={() => setShowPreview(!showPreview)}>
          {showPreview ? 'Hide Preview' : 'Show Preview'}
        </Button>
        {showPreview && (
          <div className="mt-2 border border-[var(--gray-6)] rounded-md p-3 bg-white text-sm">
            <p className="text-xs text-[var(--gray-9)] mb-2">Subject: <strong>{replaceVariables(subject, SAMPLE_CONTEXT)}</strong></p>
            <div dangerouslySetInnerHTML={{ __html: replaceVariables(body, SAMPLE_CONTEXT) }} />
          </div>
        )}
      </div>
    </div>
  );
});

export default EmailInviteTemplateEditor;
