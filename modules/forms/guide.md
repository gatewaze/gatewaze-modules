# Forms

Create custom forms, collect submissions, and associate responses with people records. This module supports portal pages, API submission, and embeddable forms, making it a flexible tool for gathering data from attendees, leads, and contacts.

## How It Works

Forms provides a full form builder and submission management system. In the admin panel, users can create forms, define fields, and review submissions from a dedicated **Forms** section in the navigation. Each form gets a public-facing portal page at `/forms/:slug` where respondents can fill it out. Forms also expose API routes for programmatic submission, enabling embedded or headless usage. Submissions are stored in the database and can be linked to people records.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `forms` | Core form rendering and portal page functionality |
| `forms.create` | Build and configure custom forms with a drag-and-drop editor |
| `forms.submissions` | View, filter, and export form submissions |

### Routes

- **Admin**: `/forms` (form list), `/forms/:formId` (form detail and submissions)
- **Portal**: `/forms/:slug` (public-facing form page)
- **API**: Programmatic form submission endpoints

## Module-locked fields

Other modules can ship pre-seeded form definitions whose **key contract** needs to survive admin edits. The forms module supports this via an optional `locked_by_module: string` annotation on each entry in `forms.fields[]`.

```jsonc
{
  "fields": [
    { "id": "full_name", "type": "text",  "label": "Full name", "required": true,
      "locked_by_module": "ambassadors" },
    { "id": "email",     "type": "email", "label": "Email",     "required": true,
      "locked_by_module": "ambassadors" },
    { "id": "bio",       "type": "textarea", "label": "Bio" }
  ]
}
```

When `locked_by_module` is present on a field, the admin form builder:

- Renders a small lock icon next to the field name and shows a `Locked: <module>` badge.
- Disables the **Delete** action (the field cannot be removed).
- Makes the field `id` (key) and `type` read-only — only `label`, `placeholder`, `required`, and `options` remain editable.

The annotation is **descriptive, not enforced** at the database level — admins editing the JSON directly via SQL can still strip it. Modules that depend on a specific key being present should ship an integrity-check function (called on module enable / on submission) that verifies the required keys are still in `forms.fields` and surfaces a hard error rather than silently breaking on new submissions. See the ambassadors module's `ambassador_check_application_form_contract()` (`spec-ambassadors-module.md` §5.2.1 + §9.1) for a worked example.

### Seeding locked fields from another module

A consuming module should seed its required form in its own idempotent migration:

```sql
INSERT INTO public.forms (slug, name, fields, is_active)
VALUES (
  'example-ambassador-application',
  'EXAMPLE Ambassador Application',
  '[
    {"id":"full_name","type":"text","label":"Full name","required":true,"locked_by_module":"ambassadors"},
    {"id":"email","type":"email","label":"Email","required":true,"locked_by_module":"ambassadors"},
    ...
  ]'::jsonb,
  true
)
ON CONFLICT (slug) DO NOTHING;
```

## Anonymous submissions (anon RLS)

The `forms_submissions` table is configured with `INSERT TO anon WITH CHECK (true)` (see `migrations/001_forms_tables.sql`) so that public, unauthenticated visitors can POST to `/api/modules/forms/:slug/submit` without an auth token. This is what makes ambassadors-style public application flows work. Don't tighten this without coordinating with all consuming modules.

## Dependencies

This module has no hard dependencies on other modules. The `locked_by_module` annotation is the integration point other modules use to depend on this one without coupling its internals.
