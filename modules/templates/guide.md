# Templates

Shared block and wrapper authoring system: marker grammar, parser, JSON-Schema content forms, source ingest (git / upload / inline), drift monitoring, a built-in A/B engine, and version pinning. This is a foundational module consumed by newsletters, sites, and future content-bearing modules — it owns no top-level UI of its own.

## How It Works

The data model is scoped per host and version-pinned throughout.

**Libraries** (`templates_libraries`) are per-host scopes, uniformly typed via `(host_kind, host_id)` — one library per host. `host_id` is nullable for `system` / platform-wide libraries. Two partial unique indexes enforce the one-library-per-host rule (one for hosts with an id, one for the NULL-host system case).

**Block definitions** (`templates_block_defs`) are the building blocks. Each `(library_id, key)` is a chain of versions where exactly one row has `is_current = true` (enforced by a partial unique index). A block has a JSON Schema (draft 2020-12), an `html` template, an optional `rich_text_template` for rich-text outputs, and a `source_kind` (`static` / `external-api` / `internal-content`). Instances in pages/editions pin to a specific `(library_id, key, version)` row, so bumping a block creates a new row and flips `is_current` without disturbing existing pages.

**Brick definitions** (`templates_brick_defs`) are nested blocks bound to a specific block-def version.

**Wrappers** (`templates_wrappers`) are page shells containing a `{{content}}` slot (validated at write time), plus declared META block keys and global seed blocks. They are version-pinned like blocks.

**Definitions** (`templates_definitions`) are top-level "starter sets" — a parsed source HTML file with the ordered list of block keys to seed when creating a new page or edition.

### Source ingest

**Sources** (`templates_sources`) feed definitions. Three input shapes converge on the same parser and tables:

- `git` — clones a repo (via the platform's git binary), reads a manifest (`gatewaze-template.json` by default), and pins to `installed_git_sha`. `available_git_sha` is set when upstream drifts; `auto_apply` controls whether drift is applied automatically.
- `upload` — an uploaded file, content-addressed by `upload_sha`.
- `inline` — inline HTML, content-addressed by `inline_sha`.

Per-kind CHECK constraints enforce that the required fields are present for each kind, and secrets are stored only as a `token_secret_ref` pointer, never as a raw token. Drift previews are staged in a separate previews table before being applied.

### Theme kinds

Migration `008` adds an immutable `theme_kind` discriminator (`html` | `nextjs`) to sources, libraries, and block defs, defaulting to `html`. Inheritance flows source → library → block def on insert, and a trigger blocks any later change. The `html` path uses the marker grammar; the `nextjs` path ingests a content schema instead (its backing tables land when a consumer installs them).

### A/B engine

The built-in engine is backed by `templates_ab_tests` (scope, weighted variants, goal event, status, optional external test id) and `templates_ab_assignments` (per-viewer sticky assignment keyed by an anonymised session key). The `IAbEngine` interface is the JS contract; external adapter sub-modules (e.g. third-party experimentation platforms) implement the same interface and may own assignment themselves rather than writing these tables.

### Parser, API, and drift monitoring

- **Parser** (`lib/parser`) implements the marker grammar — mustache ref extraction, attribute parsing, and lint checks (no secrets in HTML, triple-stash only in HTML fields, mustache refs must resolve against the schema).
- **HTTP routes** mount under `/api/modules/templates/*` (JWT-guarded) and cover source CRUD plus `/sources/:id/check`, `/apply`, `/pause`, `/unpause`, listing a library's block defs, and seeding a library from boilerplate.
- **Drift monitor** runs as a BullMQ worker (`templates:check-source-updates`) on a cron, polling active git sources for upstream changes.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `git_check_interval_ms` | 900000 (15 min) | How often the drift-monitor worker polls git sources (floor enforced by the cron). |
| `parser_timeout_ms` | 30000 | Per-source parser timeout. |
| `parser_max_files_per_source` | 50 | Max files the parser processes from one source. |
| `parser_max_bytes_per_file` | 1048576 (1 MiB) | Per-file byte cap. |

## Features

- `templates` — Core authoring: libraries, version-pinned block/brick/wrapper/definition records, marker grammar, and parser.
- `templates.editor` — Block/wrapper authoring UI and JSON-Schema content forms.
- `templates.git-sources` — Git source ingest with manifest reading, SHA pinning, and drift monitoring.
- `templates.ab.builtin` — Built-in A/B engine with weighted variants and sticky per-viewer assignment.

## Dependencies

None. Templates is a foundational module that other modules depend on. Disabling it can break dependent modules (newsletters, sites).
