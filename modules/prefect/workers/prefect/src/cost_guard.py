"""CostGuard — per-session USD budget enforcement for Claude Agent SDK runs.

Spec A.9. Each pipeline stage wraps its Claude Agent SDK session in a
CostGuard that:

- tallies input + output tokens via the SDK's usage callback,
- converts tokens → USD using the pricing table,
- aborts the session when cumulative spend crosses the stage budget,
- records the abort reason for postmortem.

Pricing values are the same as spec B.5.4; they live here as a constant
rather than in the database so the worker can still enforce budgets when
Supabase is unreachable.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# USD per 1M tokens, matching spec B.5.4.
# Keep this in sync with the `ai_model_pricing` table (Phase 3).
_PRICING: dict[str, tuple[float, float]] = {
    # model -> (input_usd_per_million, output_usd_per_million)
    "gpt-4o": (2.50, 10.00),
    "claude-sonnet-4-5-20250929": (3.00, 15.00),
    "claude-haiku-4-5-20251001": (0.80, 4.00),
    "claude-sonnet-4": (3.00, 15.00),   # alias; Phase 1 default
    "claude-haiku": (0.80, 4.00),        # alias
}


class CostExceeded(RuntimeError):
    """Raised by CostGuard when the session crosses its budget."""

    def __init__(self, stage: str, model: str, spent_usd: float, budget_usd: float) -> None:
        self.stage = stage
        self.model = model
        self.spent_usd = spent_usd
        self.budget_usd = budget_usd
        super().__init__(
            f"CostGuard aborted {stage} on {model}: spent ${spent_usd:.4f} > budget ${budget_usd:.4f}"
        )


@dataclass
class CostGuard:
    """Tracks cumulative LLM spend against a hard budget.

    Usage:
        guard = CostGuard(stage="discovery", model="claude-sonnet-4", budget_usd=0.50)
        # ...inside each agent tool-use turn:
        guard.record(input_tokens=120, output_tokens=340)
        guard.assert_within_budget()  # raises CostExceeded if over

    When used with Claude Agent SDK, register the record() call as the
    usage callback.
    """

    stage: str
    model: str
    budget_usd: float
    input_tokens: int = 0
    output_tokens: int = 0
    _overage_observed: bool = field(default=False, init=False)

    @property
    def spent_usd(self) -> float:
        input_rate, output_rate = _PRICING.get(self.model, (0.0, 0.0))
        return (self.input_tokens * input_rate + self.output_tokens * output_rate) / 1_000_000

    def record(self, *, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens += max(0, input_tokens)
        self.output_tokens += max(0, output_tokens)

    def assert_within_budget(self) -> None:
        if self.spent_usd > self.budget_usd:
            self._overage_observed = True
            raise CostExceeded(
                stage=self.stage,
                model=self.model,
                spent_usd=self.spent_usd,
                budget_usd=self.budget_usd,
            )

    def snapshot(self) -> dict[str, float | int | str]:
        return {
            "stage": self.stage,
            "model": self.model,
            "budget_usd": self.budget_usd,
            "spent_usd": round(self.spent_usd, 6),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "overage_observed": self._overage_observed,
        }
