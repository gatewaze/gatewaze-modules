-- tasks module — 017 — outbound webhook outbox (spec §3.8).
--
-- Producers (triggers, API handlers) INSERT; tasks:webhook-dispatcher
-- consumes. On webhook_id delete-cascade: pending outbox rows are
-- removed silently. This is intentional — there's no point dispatching
-- to a deleted config — but operators should know that deleting a
-- webhook config drops its outstanding deliveries.

create table if not exists public.task_webhook_outbox (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references public.board_webhooks(id) on delete cascade,
  event_type text not null,
  payload jsonb not null,
  enqueued_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  abandoned_at timestamptz
);

create index if not exists idx_webhook_outbox_pending
  on public.task_webhook_outbox (enqueued_at)
  where delivered_at is null and abandoned_at is null;
