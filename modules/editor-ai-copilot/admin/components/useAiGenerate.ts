/**
 * Client hook that wraps CanvasAiService.generate + the merger.
 *
 * Returns request state (idle | loading | success | error), an
 * `abort` controller, and a `generate(args)` callback.
 */

import { useCallback, useRef, useState } from 'react';
import { CanvasAiService, type GenerateRequest, type AiServiceError } from '../services/canvasAiService.js';
import { mergeAiResponse, type PuckData, type MergeMode, type MergeWarning } from './puck-data-merger.js';

export interface UseAiGenerateState {
  status: 'idle' | 'loading' | 'success' | 'error';
  error: AiServiceError | null;
  warnings: ReadonlyArray<string | MergeWarning>;
  lastUsage: { tokens: number; cost_approx: number; duration_ms: number } | null;
}

export interface GenerateArgs {
  /** Current Puck Data — required so the merger can produce the new tree. */
  currentData: PuckData;
  /** Forwarded to the server endpoint. */
  request: GenerateRequest;
  /** Called with the merged Puck Data on success. */
  onApply: (mergedData: PuckData) => void;
}

export function useAiGenerate(): UseAiGenerateState & { generate: (args: GenerateArgs) => Promise<void>; abort: () => void } {
  const [state, setState] = useState<UseAiGenerateState>({
    status: 'idle',
    error: null,
    warnings: [],
    lastUsage: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Re-enable the composer immediately on cancel — the in-flight request
    // rejects via its signal and is swallowed in generate()'s catch.
    setState((prev) => (prev.status === 'loading' ? { ...prev, status: 'idle' } : prev));
  }, []);

  const generate = useCallback(async (args: GenerateArgs): Promise<void> => {
    abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: 'loading', error: null, warnings: [], lastUsage: null });

    try {
      const res = await CanvasAiService.generate(args.request, controller.signal);
      if (!res.ok) {
        setState({ status: 'error', error: res.error, warnings: [], lastUsage: null });
        return;
      }
      const mode = args.request.mode as MergeMode;
      const merge = mergeAiResponse({
        mode,
        prev: args.currentData,
        ai: res.response.data,
        ...(args.request.anchorBlockId ? { anchorBlockId: args.request.anchorBlockId } : {}),
        ...(args.request.blockId ? { blockId: args.request.blockId } : {}),
      });

      // Cost is the server's authoritative ledger figure (LLM price-book
      // cost + billed web_search), so the chip matches the AI usage
      // dashboard. Do NOT re-estimate from token counts — that's how this
      // drifted ~3× low (it priced Sonnet calls at Haiku rates and ignored
      // tool spend).
      const tokens = res.response.usage.input_tokens + res.response.usage.output_tokens;
      const costApprox = res.response.usage.cost_micro_usd / 1_000_000;

      args.onApply(merge.data);
      setState({
        status: 'success',
        error: null,
        warnings: [...res.response.warnings, ...merge.warnings],
        lastUsage: { tokens, cost_approx: costApprox, duration_ms: res.response.usage.duration_ms },
      });
    } catch (err) {
      // User-initiated cancel already reset status to idle — don't surface it.
      if (controller.signal.aborted) return;
      setState({
        status: 'error',
        error: {
          code: 'client_error',
          message: err instanceof Error ? err.message : 'Generation failed',
          httpStatus: 0,
        },
        warnings: [],
        lastUsage: null,
      });
    }
  }, [abort]);

  return { ...state, generate, abort };
}
