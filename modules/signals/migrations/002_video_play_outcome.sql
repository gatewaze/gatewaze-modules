-- 002: allow 'video_play' as a signals outcome kind.
-- A video play (from the resources embed facade's /api/t beacon) is a stronger
-- engagement signal than a plain click, so it gets its own outcome kind. The
-- portal tracking relay maps event='video_play' → this kind when the played
-- page's URL carries a gw_sig fire tag. Idempotent (drop + re-add the CHECK).
alter table public.signals_outcomes
  drop constraint if exists signals_outcomes_kind_check;

alter table public.signals_outcomes
  add constraint signals_outcomes_kind_check
  check (kind in ('click', 'view', 'register', 'purchase', 'reply', 'unsubscribe', 'video_play'));
