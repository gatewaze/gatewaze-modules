import { useState, forwardRef, useImperativeHandle } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { createTemplate, updateTemplate, type InviteTemplate } from './utils/inviteTemplateService';
import { getAvailableVariables, replaceVariables, buildInviteContext } from './utils/inviteVariables';
import type { TemplateEditorHandle } from './utils/templateEditorHandle';

interface Props {
  eventUuid: string;
  template: InviteTemplate | null;
  subEventId: string | null;
  channel: 'sms' | 'whatsapp';
  onSave: () => void;
}

const SAMPLE_CONTEXT = buildInviteContext(
  { name: 'The Smiths', short_code: 'sb7gcr', members: [
    { first_name: 'Dan', last_name: 'Baker', email: 'dan@example.com', is_lead_booker: true },
  ]},
  { event_title: 'Baker-Swift Wedding', event_start: '2026-06-15T14:30:00Z', event_location: "St Mary's Church" },
  { name: 'Day Ceremony', description: 'Join us for the ceremony', starts_at: '2026-06-15T14:30:00Z' },
  'https://example.com',
);

const SmsInviteTemplateEditor = forwardRef<TemplateEditorHandle, Props>(function SmsInviteTemplateEditor(
  { eventUuid, template, subEventId, channel, onSave }: Props,
  ref,
) {
  const [name, setName] = useState(template?.name || '');
  const [body, setBody] = useState(template?.body || '');

  const variables = getAvailableVariables();
  const charCount = body.length;
  const smsSegments = Math.ceil(charCount / 160) || 1;

  const insertVariable = (variable: string) => {
    setBody(prev => prev + `{{${variable}}}`);
  };

  useImperativeHandle(ref, () => ({
    save: async () => {
      if (!name.trim()) { toast.error('Name is required'); throw new Error('Name is required'); }
      if (!body.trim()) { toast.error('Message body is required'); throw new Error('Message body is required'); }
      const data = {
        event_id: eventUuid,
        sub_event_id: subEventId,
        channel,
        name: name.trim(),
        body: body.trim(),
      };
      if (template?.id) await updateTemplate(template.id, data);
      else await createTemplate(data);
      toast.success(`${channel === 'sms' ? 'SMS' : 'WhatsApp'} template saved`);
      onSave();
    },
  }), [name, body, eventUuid, subEventId, channel, template?.id, onSave]);

  const previewText = replaceVariables(body, SAMPLE_CONTEXT);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Template Name</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder={`e.g. Day Ceremony ${channel === 'sms' ? 'SMS' : 'WhatsApp'}`}
          className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium text-[var(--gray-12)]">Message</label>
          {channel === 'sms' && (
            <span className={`text-xs ${charCount > 160 ? 'text-yellow-600' : 'text-[var(--gray-9)]'}`}>
              {charCount} chars · {smsSegments} SMS segment{smsSegments !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={6}
          placeholder={`Hi {{lead.first_name}}, you're invited to {{event.title}}! RSVP: {{invite.rsvp_link}}`}
          className="w-full px-3 py-2 text-sm border border-[var(--gray-6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)] resize-y" />
      </div>

      <div>
        <label className="block text-xs font-medium text-[var(--gray-9)] mb-1">Insert Variable</label>
        <div className="flex flex-wrap gap-1">
          {variables.filter(v => v.variable !== 'invite.qr_code').map(v => (
            <button key={v.variable} onClick={() => insertVariable(v.variable)}
              className="px-2 py-0.5 text-xs bg-[var(--gray-3)] text-[var(--gray-11)] rounded hover:bg-[var(--gray-4)] cursor-pointer">
              {v.variable}
            </button>
          ))}
        </div>
      </div>

      {/* Preview */}
      {body && (
        <div>
          <label className="block text-xs font-medium text-[var(--gray-9)] mb-1">Preview</label>
          <div className="bg-[var(--gray-3)] rounded-lg p-3 text-sm text-[var(--gray-12)] whitespace-pre-wrap">
            {previewText}
          </div>
        </div>
      )}
    </div>
  );
});

export default SmsInviteTemplateEditor;
