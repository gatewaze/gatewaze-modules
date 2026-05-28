/**
 * web-tools barrel — single import surface for the AI chatbot
 * web_search + fetch_url tool layer.
 *
 * Spec: gatewaze-environments/specs/spec-ai-chatbot-web-search.md
 */

export * from './types.js';
export { canonicaliseUrl } from './canonicalise-url.js';
export { truncateToBytes, TRUNCATION_MARKER_TEXT } from './truncate.js';
export { wrapAsFetchedContent } from './wrap-content.js';
export { TurnFetchCache } from './turn-cache.js';
export { assertPublicHost, isPrivateIp } from './ssrf-guard.js';
export {
  buildWebSearchTool,
  FETCH_URL_TOOL,
  isFetchUrlInput,
  type AnthropicServerToolWebSearch,
  type AnthropicUserToolFetchUrl,
  type FetchUrlInput,
} from './tool-defs.js';
export { fetchViaGatewazeFetch, type FetchUrlOptions } from './fetch-via-gatewaze-fetch.js';
export {
  readTodayUsage,
  bumpTodayUsage,
  shouldAllowToolCall,
  type ToolName,
  type UsageSnapshot,
  type QuotaPolicy,
  type CostEstimate,
  type SupabaseLikeRpc,
} from './quota.js';
export { SYSTEM_PROMPT_ADDENDUM, buildSystemPromptWithWebTools } from './system-prompt.js';
