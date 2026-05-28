-- Twilio SMS send log
-- Tracks all outbound SMS messages sent via the Twilio API.

create table if not exists sms_send_log (
  id uuid primary key default gen_random_uuid(),
  to_number text not null,
  body text not null,
  twilio_sid text,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'delivered', 'failed')),
  error_message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table sms_send_log is 'Audit log for SMS messages sent via Twilio';
comment on column sms_send_log.to_number is 'Recipient phone number in E.164 format';
comment on column sms_send_log.twilio_sid is 'Twilio Message SID returned from the API';
comment on column sms_send_log.metadata is 'Arbitrary context (invite ID, event ID, etc.)';

-- Index for recent-first queries
create index if not exists idx_sms_send_log_created_at
  on sms_send_log (created_at desc);

-- Row-level security
alter table sms_send_log enable row level security;

create policy "Authenticated users have full access to sms_send_log"
  on sms_send_log
  for all
  to authenticated
  using (true)
  with check (true);
