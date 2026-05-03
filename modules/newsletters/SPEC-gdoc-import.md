# Technical Specification: Google Docs Newsletter Import

## Overview / Context

The Gatewaze newsletter module supports creating newsletter editions using a block-based editor with template collections. Users have historical newsletters written as Google Docs and want to import them as past editions to build a complete back-catalog.

The import system uses AI (Claude) to analyze a Google Doc's structure, match sections to the selected template collection's block types, extract content into each block's schema fields, and create a draft edition ready for review.

**Existing system context:**
- Template collections define available block/brick types with JSON schemas
- Each block template has a `schema` describing its content fields (title, body, sources, etc.)
- Editions contain ordered blocks with JSONB content matching the template schema
- Blocks may contain bricks (sub-items) for repeating content like news items
- The `htmlUploadParser.ts` handles HTML template import (different from content import)
- Google OAuth is available via the `google-sheets` module's configuration

## Goals

1. Import a single Google Doc as a newsletter edition, with AI-powered section-to-block mapping
2. Support batch import from a Google Drive folder to backfill entire newsletter history
3. Download and upload images from Google Docs to Gatewaze storage
4. Create draft editions that can be reviewed and adjusted in the block editor before publishing
5. Preserve links, formatting, and content hierarchy from the source document

## Non-Goals

- Replacing the block editor for new editions (import is for historical backfill)
- Importing from other sources (Substack, Beehiiv, Mailchimp) — this spec covers Google Docs only
- Automatic publishing — imported editions always start as drafts
- Modifying template collections or creating new block types during import

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Admin UI                                 │
│                                                                  │
│  Newsletter Collection → Import Tab                              │
│    • Single Doc URL input                                        │
│    • Google Drive folder picker (batch)                          │
│    • Import progress & review                                    │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Edge Function: newsletter-gdoc-import          │
│                                                                  │
│  1. Fetch Google Doc via Docs API (structured JSON, not HTML)   │
│  2. Extract text, headings, links, images, lists                │
│  3. Fetch collection's block/brick templates + schemas          │
│  4. Send structured content + schemas to Claude API             │
│  5. Claude returns block-to-content mapping                     │
│  6. Download images → upload to Supabase Storage                │
│  7. Create edition + blocks + bricks in database                │
│  8. Return edition ID for review                                │
└──────────────┬───────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        External APIs                             │
│                                                                  │
│  Google Docs API    → Fetch document structure                   │
│  Google Drive API   → List docs in folder (batch)               │
│  Claude API         → Analyze structure, map to blocks           │
│  Supabase Storage   → Store downloaded images                    │
└─────────────────────────────────────────────────────────────────┘
```

## API Design

### POST /functions/v1/newsletter-gdoc-import

Import a single Google Doc as a newsletter edition.

**Request:**
```json
{
  "collection_id": "uuid",
  "google_doc_id": "string",
  "edition_date": "2026-03-10",
  "edition_title": "AAIF Weekly — March 10, 2026",
  "status": "draft"
}
```

**Response (200):**
```json
{
  "edition_id": "uuid",
  "blocks_created": 12,
  "bricks_created": 24,
  "images_imported": 3,
  "unmapped_sections": ["Section that didn't match any block"],
  "warnings": ["Image download failed for inline image at position 4"]
}
```

**Errors:**
| Code | Condition |
|------|-----------|
| 400 | Missing required fields or invalid Google Doc ID |
| 401 | Invalid authorization |
| 403 | Google OAuth token expired or insufficient permissions |
| 404 | Google Doc not found or not accessible |
| 422 | Collection has no block templates configured |
| 500 | AI processing or database error |

### POST /functions/v1/newsletter-gdoc-batch-import

Import all Google Docs from a Drive folder.

**Request:**
```json
{
  "collection_id": "uuid",
  "google_folder_id": "string",
  "date_extraction": "from_title",
  "title_pattern": "AAIF Weekly — {date}",
  "status": "draft"
}
```

**Response (200):**
```json
{
  "job_id": "uuid",
  "total_docs": 52,
  "message": "Batch import started"
}
```

The batch job processes documents sequentially and updates progress in a `newsletter_import_jobs` table. The admin UI polls for status.

### GET /functions/v1/newsletter-gdoc-import/status?job_id=uuid

Poll batch import progress.

**Response:**
```json
{
  "job_id": "uuid",
  "status": "processing",
  "total": 52,
  "completed": 15,
  "failed": 1,
  "current_doc": "AAIF Weekly — Feb 3, 2026",
  "results": [
    { "doc_id": "...", "edition_id": "uuid", "status": "success", "blocks": 12 },
    { "doc_id": "...", "edition_id": null, "status": "failed", "error": "..." }
  ]
}
```

## Component Design

### 1. Google Doc Fetcher

Fetches document content using the Google Docs API v1, which returns structured JSON (not HTML). This preserves heading levels, lists, links, and inline images as structured data.

```typescript
interface DocSection {
  heading: string;
  headingLevel: number;      // 1 = H1, 2 = H2, etc.
  paragraphs: DocParagraph[];
  subsections: DocSection[];  // Nested sections under this heading
}

interface DocParagraph {
  text: string;
  links: Array<{ text: string; url: string }>;
  formatting: { bold: boolean; italic: boolean };
  listType?: 'bullet' | 'numbered';
  images?: Array<{ objectId: string; contentUri: string; alt?: string }>;
}
```

**Google Docs API returns:**
- `document.body.content[]` — array of structural elements
- Each element is a `paragraph`, `table`, `sectionBreak`, etc.
- Paragraphs have `paragraphStyle.namedStyleType` (HEADING_1..HEADING_6, NORMAL_TEXT)
- Text runs have `textRun.content` and `textRun.textStyle` (bold, italic, link)
- Inline images have `inlineObjectElement.inlineObjectId` referencing `document.inlineObjects`

**The fetcher converts this flat structure into a nested section tree based on heading levels**, making it easy for the AI to identify logical sections.

**Auth:** Uses the Google OAuth refresh token from the `google-sheets` module config (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

### 2. AI Section Mapper

The core intelligence that maps document sections to block templates. Uses the Claude API with structured output.

**Prompt structure:**

```
You are mapping a Google Doc newsletter to a template with specific block types.

AVAILABLE BLOCK TEMPLATES:
[For each block template in the collection:]
- Block type: "news_section"
  Name: "News Section"
  Description: "A titled section with news items"
  Has bricks: true
  Schema: { section_label: string, section_id: string, ... }
  Brick types:
    - "news_item": { headline: string, description: string (HTML), sources: [{label, url}] }
    - "subsection_header": { label: string }

- Block type: "editorial"
  Name: "Editorial"
  Schema: { title: string, body: string (HTML), section_label: string }

[... all block templates ...]

STATIC BLOCKS (create with empty/default content):
- "header", "footer", "toc"

DOCUMENT CONTENT:
[Structured section tree from the Google Doc]

INSTRUCTIONS:
Map each section of the document to the most appropriate block template.
For blocks with bricks, create individual brick entries for each item.
Extract content into the exact schema fields.
Preserve all links as {text, url} objects where the schema expects them.
Convert formatting to simple HTML (bold, italic, links) for "format: html" fields.
Return sections that don't match any block type in "unmapped".
```

**Response schema (structured output):**

```typescript
interface AIMappingResult {
  blocks: Array<{
    block_type: string;
    sort_order: number;
    content: Record<string, unknown>;  // Matches the block's JSON schema
    bricks?: Array<{
      brick_type: string;
      sort_order: number;
      content: Record<string, unknown>;
    }>;
  }>;
  unmapped: Array<{
    heading: string;
    reason: string;
  }>;
  extracted_date?: string;  // If AI can detect edition date from content
}
```

**Key design decisions:**
- The AI sees the full schema definitions so it knows exactly what fields to populate
- Static blocks (header, footer, TOC) are excluded from AI mapping — they're created with empty content matching their schema (e.g., header gets `{ title: "", edition_date: "" }`, footer gets `{}`). The user fills these in during review, or they use the template's default rendering.
- The AI returns structured JSON, not freeform text — validated against the schemas
- `format: html` fields get simple HTML (paragraphs, bold, italic, links) not raw Google Docs markup

### 3. Image Processor

Downloads images from Google Docs and uploads to Supabase Storage.

**Flow:**
1. The Google Docs API returns `inlineObjects` with `contentUri` (authenticated URL)
2. Download each image using the OAuth token
3. Upload to Supabase Storage bucket `newsletter-images/{collection_slug}/{edition_date}/`
4. Get public URL
5. Replace image references in the AI mapping result with the public URLs

```typescript
interface ImageMapping {
  originalObjectId: string;   // Google Docs inline object ID
  originalUri: string;        // Google-hosted URL
  storagePath: string;        // Supabase Storage path
  publicUrl: string;          // Public URL for use in templates
}
```

**Storage bucket:** `newsletter-images` (created if not exists, public read access).

### 4. Edition Creator

Takes the AI mapping result and creates the edition + blocks + bricks in the database.

```typescript
async function createEditionFromMapping(
  supabase: SupabaseClient,
  collectionId: string,
  mapping: AIMappingResult,
  metadata: { title: string; date: string; status: string }
): Promise<{ editionId: string; blocksCreated: number; bricksCreated: number }> {
  // 1. Create edition
  const edition = await supabase.from('newsletters_editions').insert({
    title: metadata.title,
    edition_date: metadata.date,
    status: metadata.status,
    collection_id: collectionId,
  }).select('id').single();

  // 2. Look up block template IDs for each block_type
  const blockTemplates = await supabase
    .from('newsletters_block_templates')
    .select('id, block_type')
    .eq('collection_id', collectionId);

  // 3. Create edition blocks
  for (const block of mapping.blocks) {
    const templateId = blockTemplates.find(t => t.block_type === block.block_type)?.id;

    const editionBlock = await supabase.from('newsletters_edition_blocks').insert({
      edition_id: edition.id,
      block_type: block.block_type,
      block_template_id: templateId,
      sort_order: block.sort_order,
      content: block.content,
    }).select('id').single();

    // 4. Create bricks if present
    if (block.bricks) {
      const brickTemplates = await supabase
        .from('newsletters_brick_templates')
        .select('id, brick_type')
        .eq('collection_id', collectionId);

      for (const brick of block.bricks) {
        await supabase.from('newsletters_edition_bricks').insert({
          block_id: editionBlock.id,
          brick_type: brick.brick_type,
          brick_template_id: brickTemplates.find(t => t.brick_type === brick.brick_type)?.id,
          sort_order: brick.sort_order,
          content: brick.content,
        });
      }
    }
  }

  // 5. Create static blocks (header, footer) with default content
  // ...
}
```

### 5. Batch Import Job

For folder-based batch import:

```sql
CREATE TABLE IF NOT EXISTS public.newsletter_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES newsletters_template_collections(id),
  google_folder_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total_docs INTEGER DEFAULT 0,
  completed_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  results JSONB DEFAULT '[]'::jsonb,
  config JSONB DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

The batch function:
1. Lists all Google Docs in the folder via Drive API
2. Sorts by name/date
3. Processes each doc sequentially (to avoid Claude API rate limits)
4. Updates progress after each doc
5. Continues on individual failures — logs error and moves to next doc

### 6. Admin UI Component

A new tab or section in the newsletter collection settings:

**Single import:**
- Input field for Google Doc URL or ID
- Date picker for edition date
- Title field (auto-populated from doc title)
- "Import" button → shows progress → opens edition in editor on completion

**Batch import:**
- Google Drive folder picker or URL input
- Date extraction strategy selector (from title, from doc metadata, manual mapping)
- Title pattern input (e.g., "AAIF Weekly — {date}")
- Progress table showing each doc's status
- Links to review each imported edition

## Data Flow

1. **User** selects collection, pastes Google Doc URL
2. **Admin UI** calls `POST /newsletter-gdoc-import` with collection_id, doc_id, date, title
3. **Edge function** authenticates with Google using OAuth token from config
4. **Google Docs API** returns structured document JSON
5. **Doc Fetcher** converts flat content to nested section tree
6. **Edge function** loads all block/brick templates for the collection
7. **Claude API** receives section tree + template schemas, returns block mapping
8. **Image Processor** downloads images from Google, uploads to Supabase Storage
9. **Edition Creator** writes edition + blocks + bricks to database
10. **Edge function** returns edition_id + summary
11. **Admin UI** opens the edition in the block editor for review

## Authorization & Access Control

- **Who can import**: Only users with `super_admin` or `admin` role can trigger imports. Enforced by the edge function checking the JWT claims.
- **Collection-level access**: The user must have access to the target newsletter collection. The edge function verifies `collection_id` belongs to an active collection.
- **Batch concurrency**: Only one batch import job can run per collection at a time. The edge function checks for existing `processing` jobs on the collection before starting a new one. Concurrent single-doc imports to different collections are allowed.
- **Single-tenant model**: All imports operate within the single Gatewaze instance's Supabase project. No cross-tenant data access is possible.

## Content Sanitization

Imported content passes through sanitization before being stored:

1. **URL validation**: All extracted links are validated against an allowlist of protocols (`https://`, `http://`, `mailto:`). JavaScript URLs, data URIs, and other potentially dangerous schemes are stripped.
2. **HTML sanitization**: Content destined for `format: html` schema fields is sanitized using a strict allowlist: `<p>`, `<br>`, `<strong>`, `<em>`, `<a href>`, `<ul>`, `<ol>`, `<li>`. All other tags, attributes, and event handlers are stripped.
3. **Image URL validation**: Only image URLs from `*.googleusercontent.com` domains are downloaded. After upload to Supabase Storage, only the Supabase public URL is stored — the Google URL is discarded.
4. **AI output validation**: The AI's JSON response is validated against each block template's JSON Schema before database insertion. Fields that don't match the schema are dropped.

## Security Considerations

- **Google OAuth token** must be stored securely (encrypted in config). Requires `https://www.googleapis.com/auth/documents.readonly` and `https://www.googleapis.com/auth/drive.readonly` scopes.
- **Token refresh**: The refresh token is long-lived. Access tokens are obtained on each request using the refresh token. If the refresh token is revoked, the import returns 403 and prompts re-authentication via the Google OAuth flow in Settings.
- **Claude API key** stored as environment secret. Document content is sent to Claude for processing — ensure this is acceptable per data policy.
- **Image downloads** use authenticated Google URLs — tokens are not exposed to the client.
- **Edge function** requires service role key. Not callable with anon key.

## Error Handling Strategy

| Scenario | Handling |
|----------|----------|
| Google Doc not found / no access | Return 404 with descriptive error |
| OAuth token expired | Return 403, prompt user to re-authenticate |
| Claude API failure / rate limit | Retry up to 3 times with backoff, then fail with error |
| AI returns invalid block mapping | Validate against schema, skip invalid blocks, warn in response |
| Image download fails | Continue without image, include warning in response |
| Supabase Storage upload fails | Continue without image, include warning |
| Batch doc fails | Log error, continue to next doc, include in results |
| Duplicate edition date | Warn but allow — user can review and delete duplicates |

## Performance Requirements

- **Single import**: Complete within 60 seconds (Google API ~2s, Claude ~10-20s, DB writes ~2s, images ~5-10s)
- **Batch import**: ~30 seconds per document, 52 docs = ~26 minutes
- **Claude context**: Each doc should fit within 100K tokens including the template schemas
- **Image processing**: Max 20 images per doc, downloaded in parallel (5 concurrent)
- **Document size limit**: Documents exceeding 200KB of text content (roughly 50K words) are rejected with an error suggesting the user split the document. This prevents Claude context overflow and excessive processing time.
- **Image size limit**: Individual images larger than 10MB are skipped with a warning.

## Observability

- **Structured logging**: Each edge function invocation logs JSON with: function name, collection_id, doc_id, step (fetch/parse/ai/images/save), duration_ms, success/failure, and error details.
- **Import audit trail**: The `newsletter_import_jobs` table (for batch) and `newsletters_editions.metadata.import_source` (for single) record the source doc ID, import timestamp, block count, and any warnings — providing a permanent audit trail.
- **AI usage tracking**: Each import logs Claude API token usage (input/output tokens) in the import job results for cost monitoring.
- **Error surfacing**: All warnings and errors are returned in the API response and displayed in the admin UI — no silent failures.

## Testing Strategy

1. **Unit tests** for section tree builder — verify heading nesting with sample Google Docs API responses
2. **Unit tests** for AI prompt construction — verify all template schemas are included correctly
3. **Integration test** with a real Google Doc → verify edition created with correct blocks
4. **AI output validation** — verify each block's content matches its template schema
5. **Image import test** — verify download, upload, URL replacement pipeline
6. **Batch test** — import 5 docs from a folder, verify all editions created correctly
7. **Error handling** — test with inaccessible doc, expired token, malformed doc

## Migration Plan

### Phase 1: Core Import
1. Add `newsletter_import_jobs` table migration
2. Create `newsletter-gdoc-import` edge function (single doc)
3. Add import UI to collection settings

### Phase 2: Batch Import
1. Create `newsletter-gdoc-batch-import` edge function
2. Add batch import UI with folder picker and progress
3. Add status polling endpoint

### Phase 3: Refinement
1. Improve AI mapping accuracy based on real-world imports
2. Add import history/log view
3. Support re-importing (update existing edition from same doc)

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `GOOGLE_CLIENT_ID` | string | Yes | Google OAuth client ID (shared with google-sheets module) |
| `GOOGLE_CLIENT_SECRET` | secret | Yes | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | secret | Yes | Google OAuth refresh token with Docs + Drive read scopes |
| `ANTHROPIC_API_KEY` | secret | Yes | Claude API key for AI section mapping |

## Dependencies

- **google-sheets** module (for Google OAuth configuration) — or the Google OAuth config can be shared at the platform level
- **Claude API** available in the environment (ANTHROPIC_API_KEY)
- **Supabase Storage** for image uploads

## Open Questions / Future Considerations

1. **Tables in Google Docs** — the current design focuses on headings, paragraphs, lists, and images. If newsletters contain data tables, should they be converted to HTML tables in the block content, or treated as images?
2. **Re-import/update** — should re-importing the same Google Doc update the existing edition or create a new one? Phase 3 mentions this but the behavior needs to be defined (likely: match by doc ID, offer "replace" or "create new").
3. **Multiple template variants** — if a collection has both `html_template` and `rich_text_template` variants, should the AI populate both? Currently only `html_template` content is populated.
4. **Shared Google OAuth** — the dependency on google-sheets module for OAuth tokens is fragile. A platform-level Google OAuth configuration would be more robust. This is deferred to a future platform enhancement.
