-- Seed a single catch-all route so every submitted item gets at least an
-- in-app notification even when the admin hasn't configured routing yet.
-- Recipient is unassigned; in-app notification falls through to "any admin
-- can claim from queue" model. Admins can edit/delete this row later.

INSERT INTO public.content_triage_routes (
  name, description,
  content_type, category, source,
  assign_to, assign_to_team_name,
  notify_channels, priority, active
)
VALUES (
  'Default catch-all',
  'Fallback route: matches any item without a more specific rule. Leaves items unassigned so any admin can claim from the queue.',
  NULL, NULL, NULL,
  NULL, NULL,
  ARRAY['in_app'], 0, true
)
ON CONFLICT DO NOTHING;
