/**
 * Test-time stub for `image-field-adapter`. The real adapter pulls
 * `uploadHostMedia` (which transitively imports the admin's supabase
 * client) + `@heroicons/react` + `sonner`, none of which resolve in
 * the node-env vitest run for this module. Registry shape tests only
 * need a callable function that satisfies the EmailBlockEntry custom-
 * field render contract — they never mount Puck or render the
 * adapter for real.
 */
export function NewsletterImageFieldAdapter(): null {
  return null;
}
