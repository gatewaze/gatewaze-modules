#!/usr/bin/env bash
#
# bootstrap-module.sh
#
# Set up the symlinks a module needs to typecheck and run tests against the
# gatewaze workspace. Modules in gatewaze-modules/ declare peer dependencies
# on @gatewaze/shared, react, typescript, vitest, etc., but those packages
# live in the gatewaze repo — not on npm. This script links them per-module.
#
# Usage:
#   ./scripts/bootstrap-module.sh <module-dir>
#   ./scripts/bootstrap-module.sh templates
#   ./scripts/bootstrap-module.sh modules/events
#
# Idempotent: re-running re-creates symlinks. Safe to run after a fresh
# clone or when adding a new module.
#
# Run from the gatewaze-modules repo root.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <module-dir>" >&2
  echo "Example: $0 templates" >&2
  exit 2
fi

# Resolve the module directory (accept 'templates' or 'modules/templates').
MODULE_INPUT="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Strip leading 'modules/' if present.
MODULE_NAME="${MODULE_INPUT#modules/}"
MODULE_DIR="$REPO_ROOT/modules/$MODULE_NAME"

if [ ! -d "$MODULE_DIR" ]; then
  echo "error: module dir not found: $MODULE_DIR" >&2
  exit 3
fi

# Locate the gatewaze repo (sibling of gatewaze-modules by convention).
GATEWAZE_DIR="$(cd "$REPO_ROOT/../gatewaze" 2>/dev/null && pwd || true)"
if [ -z "$GATEWAZE_DIR" ] || [ ! -d "$GATEWAZE_DIR/node_modules" ]; then
  echo "error: gatewaze repo not found at $REPO_ROOT/../gatewaze, or its node_modules is missing." >&2
  echo "       Run 'pnpm install' in the gatewaze repo first." >&2
  exit 4
fi

GATEWAZE_NODE_MODULES="$GATEWAZE_DIR/node_modules"
PNPM_STORE="$GATEWAZE_NODE_MODULES/.pnpm"

mkdir -p "$MODULE_DIR/node_modules/@gatewaze"
mkdir -p "$MODULE_DIR/node_modules/.bin"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# link_pkg <pkg-name> <pkg-pnpm-root> [target-dir]
# Creates a symlink at $MODULE_DIR/node_modules/<target-dir or pkg-name>
# pointing at the given pnpm-resolved package directory.
link_pkg() {
  local pkg_name="$1"
  local pkg_root="$2"
  local target_dir="${3:-$pkg_name}"

  if [ ! -d "$pkg_root" ]; then
    echo "warn: package not found in pnpm store, skipping: $pkg_root" >&2
    return 0
  fi

  local link_path="$MODULE_DIR/node_modules/$target_dir"
  rm -rf "$link_path"
  ln -s "$pkg_root" "$link_path"
  echo "linked $target_dir -> $pkg_root"
}

# Find a single pnpm-store directory matching a glob and pick the first match.
# Usage: pnpm_pkg "<package@version>" "subpath"
# Example: pnpm_pkg "vitest@4.1.0_*" "node_modules/vitest"
pnpm_pkg() {
  local pattern="$1"
  local subpath="${2:-node_modules/}"
  # shellcheck disable=SC2207
  local matches=( $(ls -1d "$PNPM_STORE"/$pattern/"$subpath"* 2>/dev/null || true) )
  if [ ${#matches[@]} -gt 0 ]; then
    echo "${matches[0]}"
  fi
}

# ---------------------------------------------------------------------------
# Step 1: link @gatewaze/shared (always)
# ---------------------------------------------------------------------------

if [ -d "$GATEWAZE_DIR/packages/shared" ]; then
  link_pkg "@gatewaze/shared" "$GATEWAZE_DIR/packages/shared" "@gatewaze/shared"
else
  echo "warn: $GATEWAZE_DIR/packages/shared not found; skipping @gatewaze/shared link" >&2
fi

# ---------------------------------------------------------------------------
# Step 2: link react (peer dep of all admin-bearing modules)
# ---------------------------------------------------------------------------

REACT_DIR="$(pnpm_pkg 'react@*' 'node_modules/react')"
if [ -n "$REACT_DIR" ]; then
  link_pkg "react" "$REACT_DIR"
fi

# ---------------------------------------------------------------------------
# Step 3: link typescript (so tsc --noEmit works without `npx`)
# ---------------------------------------------------------------------------

TS_DIR="$(pnpm_pkg 'typescript@*' 'node_modules/typescript')"
if [ -n "$TS_DIR" ]; then
  link_pkg "typescript" "$TS_DIR"
  # Also link the tsc binary into .bin
  if [ -f "$TS_DIR/bin/tsc" ]; then
    rm -f "$MODULE_DIR/node_modules/.bin/tsc"
    ln -s "$TS_DIR/bin/tsc" "$MODULE_DIR/node_modules/.bin/tsc"
  fi
fi

# ---------------------------------------------------------------------------
# Step 3a: link @types/node — many server-side helpers reach for node:crypto,
#          node:fs, etc., even when the module isn't intrinsically Node-only.
# ---------------------------------------------------------------------------

NODE_TYPES_DIR="$(pnpm_pkg '@types+node@*' 'node_modules/@types/node')"
if [ -n "$NODE_TYPES_DIR" ]; then
  mkdir -p "$MODULE_DIR/node_modules/@types"
  link_pkg "@types/node" "$NODE_TYPES_DIR" "@types/node"
fi

# ---------------------------------------------------------------------------
# Step 3b: link express + @types/express when the module has api/ or routes/.
#          Sites and any other module exposing HTTP handlers needs these.
# ---------------------------------------------------------------------------

if [ -d "$MODULE_DIR/api" ] || [ -d "$MODULE_DIR/routes" ]; then
  EXPRESS_DIR="$(pnpm_pkg 'express@5*' 'node_modules/express')"
  if [ -z "$EXPRESS_DIR" ]; then
    EXPRESS_DIR="$(pnpm_pkg 'express@*' 'node_modules/express')"
  fi
  if [ -n "$EXPRESS_DIR" ]; then
    link_pkg "express" "$EXPRESS_DIR"
  fi
  EXPRESS_TYPES_DIR="$(pnpm_pkg '@types+express@*' 'node_modules/@types/express')"
  if [ -n "$EXPRESS_TYPES_DIR" ]; then
    link_pkg "@types/express" "$EXPRESS_TYPES_DIR" "@types/express"
  fi
  EXPRESS_CORE_TYPES_DIR="$(pnpm_pkg '@types+express-serve-static-core@*' 'node_modules/@types/express-serve-static-core')"
  if [ -n "$EXPRESS_CORE_TYPES_DIR" ]; then
    link_pkg "@types/express-serve-static-core" "$EXPRESS_CORE_TYPES_DIR" "@types/express-serve-static-core"
  fi
fi

# ---------------------------------------------------------------------------
# Step 4: link vitest if the module has any *.test.ts files
# ---------------------------------------------------------------------------

if find "$MODULE_DIR" -path "$MODULE_DIR/node_modules" -prune -o -name '*.test.ts' -print -quit 2>/dev/null | grep -q .; then
  VITEST_DIR="$(pnpm_pkg 'vitest@*' 'node_modules/vitest')"
  if [ -n "$VITEST_DIR" ]; then
    link_pkg "vitest" "$VITEST_DIR"
    # Link the vitest CLI binary into .bin
    if [ -f "$VITEST_DIR/vitest.mjs" ]; then
      rm -f "$MODULE_DIR/node_modules/.bin/vitest"
      ln -s "$VITEST_DIR/vitest.mjs" "$MODULE_DIR/node_modules/.bin/vitest"
    fi
  fi
fi

echo
echo "✓ bootstrap complete for $MODULE_NAME"
echo "  Run typecheck:  cd $MODULE_DIR && ./node_modules/.bin/tsc --noEmit"
echo "  Run tests:      cd $MODULE_DIR && node ./node_modules/vitest/vitest.mjs run"
