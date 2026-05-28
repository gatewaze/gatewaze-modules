"""Client for the self-hosted Firecrawl API.

Matches the SDK surface of the cloud firecrawl-py package, but points
at our in-cluster Firecrawl deployment via FIRECRAWL_API_URL. No cloud
API key is used; an optional bearer token can be configured.

Returns the wrapped {markdown, canonical_url, og_url, final_url, html_title}
structure the spec A.4.2 defines.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from ..config import load_config
from ..rate_limiter import RateLimiterRegistry


@dataclass
class FirecrawlResult:
    markdown: str
    canonical_url: str | None
    og_url: str | None
    final_url: str | None
    html_title: str | None


class FirecrawlClient:
    """Thin wrapper around the Firecrawl REST API.

    Call `await client.scrape(url)` — honours the shared rate limiter.
    """

    def __init__(
        self,
        *,
        rate_limiter: RateLimiterRegistry | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        cfg = load_config().firecrawl
        self._base_url = cfg.api_url.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if cfg.api_token:
            headers["Authorization"] = f"Bearer {cfg.api_token}"
        self._http = httpx.AsyncClient(headers=headers, timeout=timeout_seconds)
        self._rate_limiter = rate_limiter or RateLimiterRegistry.from_env()

    async def scrape(self, url: str) -> FirecrawlResult:
        await self._rate_limiter.acquire("firecrawl")
        resp = await self._http.post(
            f"{self._base_url}/v1/scrape",
            json={
                "url": url,
                "formats": ["markdown"],
                "onlyMainContent": True,
                # Ask Firecrawl to surface canonical + OG metadata directly
                # rather than forcing us to re-parse the HTML.
                "includeMetadata": True,
            },
        )
        resp.raise_for_status()
        body = resp.json()

        data = body.get("data", {}) if isinstance(body, dict) else {}
        meta = data.get("metadata", {}) if isinstance(data, dict) else {}
        return FirecrawlResult(
            markdown=data.get("markdown", "") or "",
            canonical_url=meta.get("canonicalUrl") or meta.get("canonical"),
            og_url=meta.get("ogUrl") or meta.get("og:url"),
            final_url=meta.get("url") or meta.get("sourceURL"),
            html_title=meta.get("title"),
        )

    async def close(self) -> None:
        await self._http.aclose()
