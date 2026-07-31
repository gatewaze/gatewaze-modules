# Spec — Issue #35: Copy-to-clipboard for the revealed signing secret (webhooks admin)

## Goal

In the webhooks admin `secretToReveal` dialog, make the one-time-visible values
easy to capture with a **Copy** button that writes to the clipboard and shows the
existing `toast.success(...)` confirmation.

Scope is a single component: `modules/webhooks/admin/components/WebhooksTab.tsx`.
No schema, API, service, or dependency changes.

## Current state (important — the issue text is partly stale)

Reading the target file shows the reveal dialog **already has a Copy button for
the secret** (`WebhooksTab.tsx:453-466`): a ghost `Button` with
`ClipboardDocumentIcon` that runs
`void navigator.clipboard.writeText(secretToReveal.secret)` then
`toast.success('Copied')`. The required imports (`toast`, `Button`,
`ClipboardDocumentIcon`) are already present (lines 28, 30, 32).

What is **missing** is a Copy affordance for the **URL**, which is currently
rendered as plain inline text at `WebhooksTab.tsx:468`
(`For URL <code>{secretToReveal.url}</code>.`).

So the delta this issue actually needs is small: add a Copy button for the URL,
matched to the existing secret-copy style. As a quality improvement (still inside
this one component), factor the copy behavior into a tiny local `CopyButton`
helper so the secret and URL share one implementation instead of duplicating the
clipboard-and-toast logic.

## Approach

1. **Add a local `CopyButton` helper** at the bottom of `WebhooksTab.tsx`
   (alongside `DeliveryStatus` / `Field`), e.g.:

   ```tsx
   function CopyButton({ value, label }: { value: string; label: string }) {
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
         <ClipboardDocumentIcon className="size-4" />
       </Button>
     );
   }
   ```

   - Keep the toast concise and consistent (`Copied secret` / `Copied URL`), or
     keep the existing bare `'Copied'` string if we want zero behavioral change to
     the secret button — decide during implementation; either is acceptable.
   - Icon color: the secret button currently uses `text-neutral-100` because it
     sits on the dark `bg-neutral-900` chip. The URL copy sits on the light
     surface, so it needs the default (dark) icon color. Handle this either with
     a `className`/`iconClassName` prop on the helper, or by keeping the icon
     color at the call site. Do **not** hardcode a light color for the URL copy.

2. **Wire the secret chip** to use `CopyButton` (replacing the inline button at
   453-466), preserving the dark-surface icon color.

3. **Add a Copy button for the URL.** Wrap the current inline URL sentence so the
   `<code>{secretToReveal.url}</code>` and a `CopyButton value={secretToReveal.url}`
   sit together, matching the component's existing spacing/typography (small,
   `text-neutral-500`). Keep the surrounding explanatory copy (the "previous
   secret remains valid…" note for rotations) intact.

Minimal alternative (if we want the smallest possible diff and skip the helper):
leave the secret button as-is and only add an inline URL Copy button that mirrors
lines 455-465 with the default icon color. The helper approach is preferred for
avoiding duplication, but both satisfy the issue.

## Files to change

- `modules/webhooks/admin/components/WebhooksTab.tsx` — only file touched.
  - No new imports required (`toast`, `Button`, `ClipboardDocumentIcon` already
    imported).
  - No changes to `webhooksService`, types, or migrations.

## Test plan

This module has no component test harness for this file (verify: no existing
`*.test.tsx` beside it). Validation is primarily type-check + manual.

1. **Type/lint:** `pnpm -w tsc --noEmit` (or the repo's typecheck script) and the
   project lint pass — must be clean.
2. **Manual, create flow:** create a subscription → reveal dialog opens → click
   Copy on the secret and on the URL → clipboard contains the exact value →
   `toast.success` appears for each.
3. **Manual, rotate flow:** rotate a secret → "Secret rotated" dialog → both Copy
   buttons work; the rotation warning note still renders.
4. **Regression:** confirm the secret chip layout (dark chip, right-aligned copy
   icon, `break-all`) is visually unchanged, and the "I've saved it" dismiss
   button still closes the modal.
5. **Edge:** copying does not close or reset the dialog (writeText is
   fire-and-forget; no state change to `secretToReveal`).

## Security review

Per CLAUDE.md, run `/security-review` (or `pragma:security`) on the branch diff
before commit. Specific points for this change:

- **No secret leakage beyond intent.** The secret is already rendered in cleartext
  in this dialog by design (one-time reveal). Copy only moves the same value the
  operator already sees to their clipboard on an explicit click — no new exposure
  surface, no logging, no network call. Do **not** add any `console.log` of the
  secret.
- **No credentials, env fallbacks, `req.body`, `.or()` filters, SQL, ICS, or URL
  construction** are involved — this is a client-only clipboard write.
- `navigator.clipboard.writeText` requires a secure context; the admin runs over
  HTTPS, and the existing secret button already relies on it, so no regression.

## Risks

- **Low overall** — client-only UI change in one component.
- **Icon contrast bug** if the URL copy icon reuses `text-neutral-100` on the
  light surface (would be invisible). Called out above; use default color there.
- **Clipboard API availability:** in a non-secure/older context `navigator.clipboard`
  may be undefined and the click would throw. The existing secret button already
  has this exact exposure, so matching it is consistent; a defensive
  `navigator.clipboard?.writeText(...)` guard is optional and out of the issue's
  stated scope — note but don't expand scope without steer.
- **Toast-string change** for the secret button (`'Copied'` → `'Copied secret'`)
  is a cosmetic behavioral tweak; keep the original string if we want strictly no
  change to existing behavior.
