-- Per-brand commit identity. Commits the agent pushes are authored with these, so a brand's
-- PRs show that brand's own GitHub user (GitHub attributes a commit to the account whose verified
-- / noreply email matches the author email) rather than a generic module identity. When unset the
-- worktree helper falls back to a neutral default.
alter table public.se_brand_settings
  add column if not exists commit_author_name  text,
  add column if not exists commit_author_email text;

comment on column public.se_brand_settings.commit_author_email is
  'Author email used for agent commits. Use the brand user''s GitHub noreply address '
  '(<id>+<login>@users.noreply.github.com) to attribute commits to that account without exposing a real email.';
