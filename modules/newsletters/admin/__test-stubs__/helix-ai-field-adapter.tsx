/**
 * Test-time stub for `helix-ai-field-adapter`. The real adapter
 * pulls AiContentField → react-dom + @heroicons + RichTextEditor +
 * supabase, none of which are present in the node-env vitest run
 * for this module. The registry shape tests just need a callable
 * function that satisfies the EmailBlockEntry type — they never
 * mount Puck or render the adapter.
 */
export function HelixAiFieldAdapter(): null {
  return null;
}
