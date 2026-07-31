# Spec — Issue #35: Copy-to-clipboard for the revealed signing secret (webhooks admin)

## Goal

In the webhooks admin `secretToReveal` dialog, make the one-time-visible values
easy to capture with **Copy** buttons that write to the clipboard via
`navigator.clipboard.writeText(...)` and show the existing `toast.success(...)`
confirmation — one for the revealed signing secret and one for the subscriber URL.

Scope is a single component:
`modules/webhooks/admin/components/WebhooksTab.tsx`.
No schema, API, service, type, or dependency changes.

## Current state (verify before writing code)

Reading the target file shows the requested feature **is already present** on this
branch. A local `CopyButton` helper exists
(`WebhooksTab.tsx:493-515`) and is wired into the reveal dialog for both values:

- Secret chip — `CopyButton value={secretToReveal.secret} label="secret"
  iconClassName="text-neutral-100"` on the dark `bg-neutral-900` chip
  (`WebhooksTab.tsx:453-460`).
- URL line — `CopyButton value={secretToReveal.url} label="URL"` on the light
  surface, default icon color (`WebhooksTab.tsx:461-463`).

The helper runs `void navigator.clipboard.writeText(value)` then
`toast.success(\`Copied ${label}\`)`, giving `Copied secret` / `Copied URL`
(`WebhooksTab.tsx:506-509`). Required imports are already in place: `toast`
(line 30), `Button` (line 32), and `ClipboardDocumentIcon` (line 28).

**Implication:** the issue is effectively satisfied by existing code. The correct
action for an implementer is to **verify** this matches the acceptance criteria
rather than re-add duplicate buttons. This spec documents the intended shape so a
reviewer can confirm the code, and so the change can be re-derived if the code is
ever reverted.

## Approach (the intended implementation)

1. **A local `CopyButton` helper** at the bottom of `WebhooksTab.tsx` (alongside
   `DeliveryStatus` / `Field`), accepting `value`, `label`, and an optional
   `iconClassName` for surface-dependent icon contrast:

   ```tsx
   function CopyButton({
     value,
     label,
     iconClassName,
   }: {
     value: string;
     label: string;
     iconClassName?: string;
   }) {
     return (
       <Button
         variant="ghost"
         size="sm"
         onClick={() => {
           void navigator.clipboard.writeText(value);
           toast.success(`Copied ${label}`);
         }}
         title={`Copy ${label}`}
       >
         <ClipboardDocumentIcon className={`size-4${iconClassName ? ` ${iconClassName}` : ''}`} />
       </Button>
     );
   }
   ```

2. **Secret chip** uses `CopyButton` inside the dark chip, passing
   `iconClassName="text-neutral-100"` so the icon stays visible on
   `bg-neutral-900`. Chip keeps its `break-all`, flex layout, and right-aligned
   icon.

3. **URL line** uses `CopyButton` next to `<code>{secretToReveal.url}</code>` with
   the **default** (dark) icon color — must not reuse `text-neutral-100`, which
   would be invisible on the light surface. The surrounding explanatory copy
   (including the "previous secret remains valid…" note shown when `rotated`) stays
   intact; the paragraph uses `flex items-center gap-1 flex-wrap` so the inline
   button wraps cleanly.

Sharing one helper avoids duplicating the clipboard-and-toast logic between the two
call sites.

## Files to change

- `modules/webhooks/admin/components/WebhooksTab.tsx` — the only file touched.
  - No new imports required (`toast`, `Button`, `ClipboardDocumentIcon` already
    imported).
  - No changes to `webhooksService`, exported types, or migrations.

## Test plan

This file has no component test harness (verify: no `*.test.tsx` beside it), so
validation is type-check + manual.

1. **Type/lint:** run the repo's typecheck and lint scripts — must be clean.
2. **Manual, create flow:** create a subscription → reveal dialog opens → click
   Copy on the secret and on the URL → clipboard holds the exact value →
   `toast.success` (`Copied secret` / `Copied URL`) appears for each.
3. **Manual, rotate flow:** rotate a secret → "Secret rotated" dialog → both Copy
   buttons work and the rotation warning note still renders.
4. **Regression:** secret chip layout (dark chip, right-aligned copy icon,
   `break-all`) is visually unchanged; URL copy icon is visible (dark on light);
   the "I've saved it" button still dismisses the modal.
5. **Edge:** copying does not close or reset the dialog — `writeText` is
   fire-and-forget with no state change to `secretToReveal`.

## Security review

Per CLAUDE.md, run `/security-review` (or `pragma:security`) on the branch diff
before commit. Points specific to this change:

- **No new secret exposure.** The secret is already rendered in cleartext in this
  dialog by design (one-time reveal). Copy only moves the value the operator
  already sees to their clipboard on an explicit click — no logging, no network
  call, no persistence. Do **not** `console.log` the secret or URL.
- **No credentials, `env || 'literal'` fallbacks, `req.body`, PostgREST `.or()`
  filters, SQL, ICS lines, or constructed URLs** are involved — this is a
  client-only clipboard write, so the high-frequency boundaries in the working
  agreement do not apply here.
- `navigator.clipboard.writeText` requires a secure context; the admin runs over
  HTTPS and the existing behavior already relies on it — no regression.

## Risks

- **Low overall** — client-only UI change confined to one component.
- **Icon contrast:** reusing `text-neutral-100` for the URL copy on the light
  surface would render an invisible icon. Keep the default color there (already
  the case in current code).
- **Clipboard API availability:** in a non-secure/older context
  `navigator.clipboard` can be `undefined` and the click would throw. Both copy
  buttons share this exposure equally; a defensive
  `navigator.clipboard?.writeText(...)` guard is optional and outside the issue's
  stated scope — note it, don't expand scope without a steer.
- **Duplicate-work risk:** because the feature already exists, the main hazard is
  an implementer re-adding a second set of buttons. Verify first; change nothing if
  the code already matches this spec.
