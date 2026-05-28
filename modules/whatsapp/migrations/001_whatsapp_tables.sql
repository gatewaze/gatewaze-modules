-- WhatsApp send log
-- Tracks all outbound WhatsApp messages sent via the Twilio WhatsApp API.

create table if not exists whatsapp_send_log (
  id uuid primary key default gen_random_uuid(),
  to_number text not null,
  body text not null,
  template_name text,
  twilio_sid text,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'delivered', 'read', 'failed')),
  error_message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table whatsapp_send_log is 'Audit log for WhatsApp messages sent via Twilio';
comment on column whatsapp_send_log.to_number is 'Recipient phone number in E.164 format';
comment on column whatsapp_send_log.template_name is 'WhatsApp pre-approved template name, if used';
comment on column whatsapp_send_log.twilio_sid is 'Twilio Message SID returned from the API';
comment on column whatsapp_send_log.metadata is 'Arbitrary context (invite ID, event ID, etc.)';

-- Index for recent-first queries
create index if not exists idx_whatsapp_send_log_created_at
  on whatsapp_send_log (created_at desc);

-- Row-level security
alter table whatsapp_send_log enable row level security;

create policy "Authenticated users have full access to whatsapp_send_log"
  on whatsapp_send_log
  for all
  to authenticated
  using (true)
  with check (true);
