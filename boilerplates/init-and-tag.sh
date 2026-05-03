#!/usr/bin/env bash
# Initialize the two boilerplate repos as proper git repos with an
# initial commit + v1.0.0 tag, ready to push to github.com/gatewaze/.
#
# Usage:
#   bash boilerplates/init-and-tag.sh
#   # then per-repo:
#   cd boilerplates/gatewaze-template-site
#   git remote add origin git@github.com:gatewaze/gatewaze-template-site.git
#   git push -u origin main && git push --tags
#
# Re-runnable: skips repos that already have a .git directory.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

init_repo() {
  local dir="$1"
  local name="$2"
  if [ -d "$ROOT/$dir/.git" ]; then
    echo "skip: $dir already has .git/"
    return
  fi
  cd "$ROOT/$dir"
  git init -b main
  git add -A
  GIT_AUTHOR_NAME=gatewaze \
  GIT_AUTHOR_EMAIL=noreply@gatewaze.local \
  GIT_COMMITTER_NAME=gatewaze \
  GIT_COMMITTER_EMAIL=noreply@gatewaze.local \
    git commit -m "Initial $name template (v1.0.0)"
  git tag -a v1.0.0 -m "v1.0.0"
  echo "ok:  $dir initialized + tagged v1.0.0"
  cd "$ROOT"
}

init_repo "gatewaze-template-site" "site"
init_repo "gatewaze-template-newsletter" "newsletter"

echo ""
echo "Next steps:"
echo "  cd boilerplates/gatewaze-template-site"
echo "  git remote add origin git@github.com:gatewaze/gatewaze-template-site.git"
echo "  git push -u origin main && git push --tags"
echo ""
echo "  cd boilerplates/gatewaze-template-newsletter"
echo "  git remote add origin git@github.com:gatewaze/gatewaze-template-newsletter.git"
echo "  git push -u origin main && git push --tags"
