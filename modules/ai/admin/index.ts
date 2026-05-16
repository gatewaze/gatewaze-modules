/**
 * Public admin export — `<AiChatWidget />` is the load-bearing API
 * other modules consume to embed a chat surface.
 */

export { default as AiChatWidget } from './components/AiChatWidget';
export type { AiChatWidgetProps } from './components/AiChatWidget';

// Re-export the service utilities + types so consumers can fetch
// thread state, list use-case models, etc., without importing from
// a deep path.
export * from './utils/aiService';
