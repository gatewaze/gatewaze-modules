/**
 * Public admin export — `<AiChatWidget />` is the load-bearing API
 * other modules consume to embed a chat surface.
 */

export { default as AiChatWidget } from './components/AiChatWidget';
export type { AiChatWidgetProps } from './components/AiChatWidget';

// Multi-model parallel-comparison wrapper. Each tab is its own thread
// (keyed by `thread_key=<modelId>`), so flipping between models doesn't
// pollute history. Includes a "Run on all tabs" action that fires the
// use case's kickoff_message against every open tab in parallel.
export { default as AiChatModelTabs } from './components/AiChatModelTabs';
export type { AiChatModelTabsProps } from './components/AiChatModelTabs';

// Re-export the service utilities + types so consumers can fetch
// thread state, list use-case models, etc., without importing from
// a deep path.
export * from './utils/aiService';
