"""Runtime configuration loaded from environment variables.

Every setting here corresponds to an entry in the module's configSchema
(see ../../index.ts). Defaults match the spec (A.9 cost budgets, A.8
max_turns).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import cache


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Required environment variable {name!r} is not set. "
            "See the prefect-worker module configSchema."
        )
    return value


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise RuntimeError(f"Environment variable {name!r} must be a float, got {raw!r}") from exc


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"Environment variable {name!r} must be an int, got {raw!r}") from exc


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    agent_reader_key: str
    agent_writer_key: str


@dataclass(frozen=True)
class FirecrawlConfig:
    api_url: str
    api_token: str | None


@dataclass(frozen=True)
class CostBudgets:
    discovery_usd: float
    triage_usd: float
    processing_usd: float


@dataclass(frozen=True)
class ModelConfig:
    anthropic_api_key: str
    openai_api_key: str | None
    default_model: str = "claude-sonnet-4-5-20250929"


@dataclass(frozen=True)
class ThirdPartyConfig:
    github_token: str | None
    youtube_api_key: str | None


@dataclass(frozen=True)
class WebhookConfig:
    gatewaze_base_url: str
    secret: str


@dataclass(frozen=True)
class WorkerConfig:
    supabase: SupabaseConfig
    firecrawl: FirecrawlConfig
    costs: CostBudgets
    models: ModelConfig
    third_party: ThirdPartyConfig
    webhook: WebhookConfig
    agent_max_turns: int = 25


@cache
def load_config() -> WorkerConfig:
    """Load and cache the worker configuration.

    Called once at worker startup. Raises RuntimeError on missing required
    variables so the worker fails fast rather than booting into a broken
    state.
    """
    return WorkerConfig(
        supabase=SupabaseConfig(
            url=_required("SUPABASE_URL"),
            agent_reader_key=_required("SUPABASE_AGENT_READER_KEY"),
            agent_writer_key=_required("SUPABASE_AGENT_WRITER_KEY"),
        ),
        firecrawl=FirecrawlConfig(
            api_url=_required("FIRECRAWL_API_URL"),
            api_token=os.environ.get("FIRECRAWL_API_TOKEN") or None,
        ),
        costs=CostBudgets(
            discovery_usd=_float("DISCOVERY_COST_BUDGET_USD", 0.50),
            triage_usd=_float("TRIAGE_COST_BUDGET_USD", 0.20),
            processing_usd=_float("PROCESSING_COST_BUDGET_USD", 0.30),
        ),
        models=ModelConfig(
            anthropic_api_key=_required("ANTHROPIC_API_KEY"),
            openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
        ),
        third_party=ThirdPartyConfig(
            github_token=os.environ.get("GITHUB_TOKEN") or None,
            youtube_api_key=os.environ.get("YOUTUBE_API_KEY") or None,
        ),
        webhook=WebhookConfig(
            gatewaze_base_url=_required("GATEWAZE_BASE_URL"),
            secret=_required("PREFECT_WEBHOOK_SECRET"),
        ),
        agent_max_turns=_int("AGENT_MAX_TURNS", 25),
    )
