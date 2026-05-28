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
  }, []);

  const generate = useCallback(async (args: GenerateArgs): Promise<void> => {
    abort();
    abortRef.current = new AbortController();
    setState({ status: 'loading', error: null, warnings: [], lastUsage: null });

    const res = await CanvasAiService.generate(args.request);
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

    // Token-to-cost approximate. Haiku 4.5: $1/M input, $5/M output.
    const tokens = res.response.usage.input_tokens + res.response.usage.output_tokens;
    const costApprox =
      (res.response.usage.input_tokens / 1_000_000) * 1.0 +
      (res.response.usage.output_tokens / 1_000_000) * 5.0;

    args.onApply(merge.data);
    setState({
      status: 'success',
      error: null,
      warnings: [...res.response.warnings, ...merge.warnings],
      lastUsage: { tokens, cost_approx: costApprox, duration_ms: res.response.usage.duration_ms },
    });
  }, [abort]);

  return { ...state, generate, abort };
}
