/**
 * Bot Detector Interface
 *
 * Defines the contract that bot detection sub-modules must implement.
 * The bulk-emailing module stores ALL raw interactions — bot detectors
 * score them after the fact, enabling comparison of different algorithms.
 */

export interface InteractionContext {
  eventType: 'open' | 'click';
  eventTimestamp: Date;
  deliveredAt: Date | null;
  userAgent: string | null;
  ip: string | null;
  clickedUrl: string | null;
  recipientEmail: string;
  /** Recent interactions for this email (for pattern detection) */
  recentInteractions: Array<{
    event_type: string;
    event_timestamp: Date;
    clicked_url: string | null;
    user_agent: string | null;
    ip_address: string | null;
  }>;
  /** Historical engagement for this recipient (for corroboration) */
  recipientHistory: {
    humanOpenCount: number;
    humanClickCount: number;
  };
}

export interface BotSignal {
  id: string;
  adjustment: number;
  detail?: string;
}

export interface BotDetectionResult {
  humanConfidence: number;
  signals: BotSignal[];
  scorerId: string;
}

/**
 * The contract that bot detector sub-modules must implement.
 * Each detector is a separate Gatewaze module (e.g., email-bot-detector-signals).
 */
export interface BotDetectorModule {
  /** Detector identifier (e.g., 'signals-v1') */
  scorerId: string;

  /** Score a single interaction for human likelihood */
  score(context: InteractionContext): Promise<BotDetectionResult>;

  /**
   * Batch re-score historical interactions.
   * Used when deploying a new detector to backfill scores.
   */
  batchRescore?(
    interactions: Array<{ id: string; context: InteractionContext }>
  ): Promise<Array<{ id: string; result: BotDetectionResult }>>;
}
