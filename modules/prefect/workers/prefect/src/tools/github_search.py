"""`github_search` custom MCP tool.

Wraps the GitHub Search API (`/search/repositories`, `/search/issues`,
`/search/code`) behind the shared rate_limiter. Used by the discovery
agent for `github_topic` and `github_repo` sources (spec A.5.1).

Spec A.5.3: GitHub is authenticated, 5000 req/hr. The limiter ensures
multiple worker replicas don't collectively exceed that quota.
"""

from __future__ import annotations

from typing import Any, Literal

import httpx

from ..config import load_config
from ..rate_limiter import RateLimiterRegistry

SearchKind = Literal["repositories", "issues", "code"]

_GITHUB_API = "https://api.github.com"


async def github_search(
    query: str,
    *,
    kind: SearchKind = "repositories",
    max_results: int = 25,
    rate_limiter: RateLimiterRegistry | None = None,
) -> dict[str, Any]:
    """Execute a GitHub Search API query.

    Returns a dict shaped for the agent:
        {
          "kind": "repositories" | "issues" | "code",
          "query": str,
          "total_count": int,
          "items": [... shape depends on kind ...],
          "truncated": bool,
        }

    The `items` list is trimmed to `max_results` entries with only the
    fields the agent actually consumes (full name, URL, description,
    updated_at, stars/reactions) — keeps agent context bounded.
    """
    if kind not in ("repositories", "issues", "code"):
        raise ValueError(f"Unsupported github_search kind: {kind!r}")
    if max_results < 1 or max_results > 100:
        raise ValueError("max_results must be between 1 and 100")

    limiter = rate_limiter or RateLimiterRegistry.from_env()
    await limiter.acquire("github")

    cfg = load_config().third_party
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gatewaze-prefect-worker",
    }
    if cfg.github_token:
        headers["Authorization"] = f"Bearer {cfg.github_token}"

    async with httpx.AsyncClient(headers=headers, timeout=30.0) as client:
        resp = await client.get(
            f"{_GITHUB_API}/search/{kind}",
            params={"q": query, "per_page": max_results},
        )
        resp.raise_for_status()
        body = resp.json()

    items_raw: list[dict[str, Any]] = body.get("items", []) or []
    trimmed = [_trim_item(kind, item) for item in items_raw[:max_results]]

    return {
        "kind": kind,
        "query": query,
        "total_count": int(body.get("total_count", 0)),
        "items": trimmed,
        "truncated": len(items_raw) > max_results,
    }


def _trim_item(kind: SearchKind, item: dict[str, Any]) -> dict[str, Any]:
    """Strip the GitHub response down to the fields the agent consumes.

    Keeping this narrow avoids flooding the agent's context with
    license/owner/fork metadata it doesn't need.
    """
    if kind == "repositories":
        return {
            "full_name": item.get("full_name"),
            "html_url": item.get("html_url"),
            "description": item.get("description"),
            "stars": item.get("stargazers_count"),
            "language": item.get("language"),
            "updated_at": item.get("updated_at"),
            "pushed_at": item.get("pushed_at"),
        }
    if kind == "issues":
        return {
            "title": item.get("title"),
            "html_url": item.get("html_url"),
            "state": item.get("state"),
            "repo": _repo_from_issue_url(item.get("repository_url")),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "reactions_total": (item.get("reactions") or {}).get("total_count"),
        }
    # code
    return {
        "path": item.get("path"),
        "html_url": item.get("html_url"),
        "repo": (item.get("repository") or {}).get("full_name"),
    }


def _repo_from_issue_url(url: str | None) -> str | None:
    """Extract `owner/repo` from the issue's `repository_url` field."""
    if not url:
        return None
    prefix = f"{_GITHUB_API}/repos/"
    return url[len(prefix):] if url.startswith(prefix) else url
