# Newsletter Module Overhaul — Technical Specification

**Status:** Final (adversarial review: 2 rounds, models: GPT-4o, Gemini 2.5 Flash, Claude Opus 4.6)

## 1. Overview

This spec covers improvements to the Gatewaze newsletters module, a block-based newsletter editor built with React, @dnd-kit, and Supabase. The module supports multiple output formats (HTML email, Substack, Beehiiv) and link shortening (Short.io, Bitly).

**Goals:**
- Enhance editor UX with resizable panels, device/theme preview, and positional drag-and-drop
- Introduce an AI content block field type with prompt/output/chat tabs
- Verify output adapters and redirect integrations work correctly
- Extend templates with AI content block for MLOps collection

**Non-Goals:**
- Connecting the AI prompt/chat to external AI APIs (deferred to future work)
- Full newsletter system architecture overhaul
- Mobile-responsive admin editor (admin is desktop-only)

## 2. Architecture Context

The newsletter system consists of:
- **Core module** (`newsletters/`) — editor UI, block/brick system, template engine, link generation
- **Output adapters** (`newsletters-output-html/`, `-substack/`, `-beehiiv/`) — render edition to format-specific HTML
- **Redirect adapters** (`redirects-shortio/`, `redirects-bitly/`) — shorten links per channel

**Data flow:** User edits blocks in EditionCanvas -> blocks store content as JSON -> previewRenderer generates HTML from Mustache templates -> output adapters wrap in format-specific boilerplate -> link replacement swaps URLs with short URLs.

## 3. Editor UX Overhaul

### 3.1 Resizable Editor/Preview Panels

**Change:** Add a draggable resize handle between editor and preview.

**State:** `previewWidth` persisted to `localStorage('newsletter-preview-width')`, default 650px, min 400px, max `window.innerWidth - 500`.

**Resize handler:** mousedown -> mousemove (update width) -> mouseup (persist to localStorage). CSS `user-select: none` during drag to prevent text selection.

### 3.2 Device & Theme Preview Toggles

**Toolbar above preview iframe:**
- Device: Desktop (full width) | Mobile (375px centered with device frame)
- Theme: Light (default) | Dark (inject dark CSS overrides into iframe)

**Dark mode injection (into iframe document):**
```css
body { background: #1a1a2e !important; color: #e0e0e0 !important; }
a { color: #6db3f2 !important; }
img { opacity: 0.9; }
table { border-color: #333 !important; }
```

### 3.3 Improved Drag-and-Drop Positioning

**Current:** Palette items drop onto a single `canvas-drop-zone` -> appended to end.

**New:** Between every pair of blocks (and at top/bottom), render drop indicator zones using `useDroppable`. When palette item drops between blocks, insert at that index.

**Drop indicators:** Thin horizontal lines that expand and highlight blue on drag-over. IDs follow pattern `insert-{index}`.

## 4. AI Content Block Type

### 4.1 Field Type: `ai_content`

Schema format value that triggers the AI content editor:
```json
{
  "type": "string",
  "format": "ai_content",
  "title": "Content",
  "x-ai-config": {
    "systemPrompt": "You are writing...",
    "maxTokens": 2000
  }
}
```

### 4.2 AiContentField Component

New component: `newsletters/admin/components/AiContentField.tsx`

**Three tabs (Radix Tabs):**
1. **Prompt** — RichTextEditor, stored in `content[fieldName + '_prompt']`. "Generate" button (disabled, placeholder).
2. **Output** — RichTextEditor, stored in `content[fieldName]`. This is what templates render.
3. **Chat** — Placeholder message list UI + disabled input. "Coming soon" notice.

### 4.3 Data Storage

In block content JSON — no schema migration needed:
```json
{
  "ai_body": "<p>Output content</p>",
  "ai_body_prompt": "Write about...",
  "ai_body_chat": []
}
```

### 4.4 Link Extraction

AI content output (`ai_body`) is HTML — existing rich-text link extraction regex handles it. Add `ai_summary` to `linkGenerator.ts` block type mapping with `ai_body` as a rich text field.

## 5. Output Adapter Verification

### 5.1 HTML Output Adapter
- Fully functional. No changes needed.

### 5.2 Substack/Beehiiv Adapters
- Use `rich_text_template` variant when available
- AI content blocks render via `{{ai_body}}` — works with both template variants
- Excluded blocks (header, footer, sponsored_ad) unchanged

### 5.3 Fallback Simplification
When `rich_text_template` is not available, output adapters strip table layout and preserve semantic HTML.

## 6. Redirect Integration

Both Short.io and Bitly adapters implement `IRedirectAdapter.createBulk()`. Existing retry logic (exponential backoff, max 5 retries) handles rate limits and conflicts. AI content block links are extracted via the same HTML regex as other rich text fields.

## 7. Template Extension

### 7.1 Migration: `006_ai_summary_block.sql`

Seeds `ai_summary` block template into all existing template collections with both `html_template` and `rich_text_template` variants.

### 7.2 BlockPalette Icon
Add `ai_summary: SparklesIcon` to icon mapping.

### 7.3 MLOps Template HTML
Add AI Summary block comment to `mlops-community.html`.

## 8. Error Handling

- Resize: clamp values, catch edge cases
- DnD: failed drops cause no state change
- AI content: initialize empty if no prompt/chat data exists
- Output: show error with block name if render fails
- Redirects: existing retry with exponential backoff

## 9. Files Modified

| File | Changes |
|------|---------|
| `EditionCanvas.tsx` | Resizable panels, drop indicators between blocks |
| `HtmlPreview.tsx` | Device/theme toggles, min-width enforcement |
| `BlockEditor.tsx` | AI content field detection + rendering |
| `BlockPalette.tsx` | ai_summary icon mapping |
| `linkGenerator.ts` | ai_summary block in link extraction |
| New: `AiContentField.tsx` | Tabbed AI content editor component |
| New: `006_ai_summary_block.sql` | Seed AI Summary block template |
| `mlops-community.html` | Add AI Summary block |
| `index.ts` | Add migration to list |
