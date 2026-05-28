"""Redis-backed token-bucket rate limiter shared across worker replicas.

Spec A.5.3. Each third-party provider gets its own bucket with the budget
and refill rate matching the provider's published limits. The limiter is
Redis-backed so multiple Prefect worker replicas don't collectively
exceed provider quotas.

If REDIS_URL is not set (local dev, single replica), the limiter falls
back to an in-process asyncio lock implementation. The API surface is
identical.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

try:
    import redis.asyncio as redis  # type: ignore
except ImportError:  # pragma: no cover - redis is an optional dependency in local dev
    redis = None  # type: ignore


@dataclass(frozen=True)
class BucketConfig:
    """Configuration for a single provider's rate bucket.

    Mirrors the table in spec A.5.3.
    """

    name: str
    capacity: int
    refill_per_second: float
    description: str = ""


# Defaults for the providers the discovery pipeline touches.
# Update here when a provider's published limits change.
DEFAULT_BUCKETS: dict[str, BucketConfig] = {
    "github": BucketConfig(
        name="github",
        capacity=5_000,
        refill_per_second=5_000 / 3600,  # 5000/hr
        description="GitHub API (authenticated)",
    ),
    "youtube": BucketConfig(
        name="youtube",
        capacity=100,
        refill_per_second=100 / 86400,  # 100 searches/day
        description="YouTube Data API v3 (cost-bounded at 100 searches/day)",
    ),
    "reddit": BucketConfig(
        name="reddit",
        capacity=60,
        refill_per_second=1.0,
        description="Reddit API",
    ),
    "luma": BucketConfig(
        name="luma",
        capacity=200,
        refill_per_second=200 / 60,
        description="Luma API (Luma Plus)",
    ),
    "firecrawl": BucketConfig(
        name="firecrawl",
        capacity=10,
        refill_per_second=1.0,
        description="Self-hosted Firecrawl (concurrency-bounded at 10 in flight)",
    ),
}


class _InProcessLimiter:
    """Single-process fallback when Redis isn't available.

    State lives per-limiter-instance; multiple worker replicas will NOT
    coordinate. Fine for local dev; use the Redis path in k8s.
    """

    def __init__(self, cfg: BucketConfig) -> None:
        self._cfg = cfg
        self._tokens = float(cfg.capacity)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, cost: int = 1) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                elapsed = now - self._last
                self._tokens = min(
                    self._cfg.capacity,
                    self._tokens + elapsed * self._cfg.refill_per_second,
                )
                self._last = now
                if self._tokens >= cost:
                    self._tokens -= cost
                    return
                missing = cost - self._tokens
                wait = missing / self._cfg.refill_per_second
                await asyncio.sleep(min(wait, 1.0))


class _RedisLimiter:
    """Redis Lua-scripted token bucket.

    Uses a single-atomic-update pattern so multiple replicas remain
    consistent. One Redis key per bucket, encoding (tokens, last_refill).
    """

    _SCRIPT = """
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill = tonumber(ARGV[2])
    local cost = tonumber(ARGV[3])
    local now = tonumber(ARGV[4])

    local data = redis.call("HMGET", key, "tokens", "last")
    local tokens = tonumber(data[1])
    local last = tonumber(data[2])
    if tokens == nil then tokens = capacity end
    if last == nil then last = now end

    local elapsed = now - last
    if elapsed > 0 then
      tokens = math.min(capacity, tokens + elapsed * refill)
    end

    if tokens < cost then
      local deficit = cost - tokens
      local wait = deficit / refill
      redis.call("HMSET", key, "tokens", tokens, "last", now)
      redis.call("EXPIRE", key, math.ceil(capacity / refill) + 60)
      return math.ceil(wait * 1000)
    end

    tokens = tokens - cost
    redis.call("HMSET", key, "tokens", tokens, "last", now)
    redis.call("EXPIRE", key, math.ceil(capacity / refill) + 60)
    return 0
    """

    def __init__(self, client: "redis.Redis", cfg: BucketConfig) -> None:
        self._client = client
        self._cfg = cfg
        self._script_sha: str | None = None

    async def acquire(self, cost: int = 1) -> None:
        key = f"gw:ratelimit:{self._cfg.name}"
        while True:
            wait_ms = await self._client.eval(  # type: ignore[attr-defined]
                self._SCRIPT,
                1,
                key,
                self._cfg.capacity,
                self._cfg.refill_per_second,
                cost,
                time.time(),
            )
            if int(wait_ms) == 0:
                return
            await asyncio.sleep(int(wait_ms) / 1000)


class RateLimiterRegistry:
    """Resolves and caches per-provider limiters.

    Usage:
        registry = RateLimiterRegistry.from_env()
        await registry.acquire("github")
        # ...make the GitHub API call...
    """

    def __init__(self, redis_url: str | None = None) -> None:
        self._redis_url = redis_url
        self._client: "redis.Redis | None" = None
        self._limiters: dict[str, _RedisLimiter | _InProcessLimiter] = {}

    @classmethod
    def from_env(cls) -> "RateLimiterRegistry":
        return cls(redis_url=os.environ.get("REDIS_URL") or None)

    async def _ensure_client(self) -> "redis.Redis | None":
        if self._redis_url is None or redis is None:
            return None
        if self._client is None:
            self._client = redis.from_url(self._redis_url, decode_responses=True)
        return self._client

    async def acquire(self, provider: str, cost: int = 1) -> None:
        if provider not in DEFAULT_BUCKETS:
            raise KeyError(f"Unknown rate-limit provider: {provider!r}")
        cfg = DEFAULT_BUCKETS[provider]

        limiter = self._limiters.get(provider)
        if limiter is None:
            client = await self._ensure_client()
            limiter = _RedisLimiter(client, cfg) if client is not None else _InProcessLimiter(cfg)
            self._limiters[provider] = limiter

        await limiter.acquire(cost=cost)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
