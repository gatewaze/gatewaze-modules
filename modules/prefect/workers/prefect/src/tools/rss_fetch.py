"""`rss_fetch` custom MCP tool.

Parses an RSS / Atom feed and returns recent entries as a list of
structured items the discovery agent can inspect. Acts as the worked
example for how other custom tools (github_search, supabase_query,
supabase_insert_submission, etc.) should be implemented.

Design notes:
- Uses `feedparser` which handles RSS 2.0, RSS 1.0, and Atom transparently.
- The raw entry content is wrapped in a `<scraped-content>` envelope
  before the agent sees it (spec A.8 #2). The envelope lives in
  `agents/prompts.py` so individual tools don't have to know about it;
  tools return raw data, the agent runtime wraps it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import feedparser

from ..rate_limiter import RateLimiterRegistry


async def rss_fetch(feed_url: str, *, max_entries: int = 50) -> dict[str, Any]:
    """Fetch and parse an RSS/Atom feed.

    Returns a dict shaped for the agent's consumption:
        {
          "feed_title": str,
          "entries": [
            {"title": str, "url": str, "published": iso8601, "summary": str}
          ],
          "truncated": bool,   # true if max_entries cut the list
        }
    """
    # feedparser itself is blocking; run in a thread to avoid stalling the
    # event loop. For Phase 1 traffic this is fine; if RSS becomes a
    # bottleneck we can switch to aiohttp + streaming parse.
    import asyncio

    parsed = await asyncio.to_thread(feedparser.parse, feed_url)
    entries_raw = list(parsed.entries or [])
    truncated = len(entries_raw) > max_entries
    entries_raw = entries_raw[:max_entries]

    entries: list[dict[str, str]] = []
    for e in entries_raw:
        url = getattr(e, "link", "") or ""
        if not url:
            continue
        title = (getattr(e, "title", "") or "").strip()
        published = _coerce_published(e)
        summary = (getattr(e, "summary", "") or "").strip()
        entries.append(
            {
                "title": title,
                "url": url,
                "published": published,
                "summary": summary[:2000],  # cap per-entry summary to bound context
            }
        )

    return {
        "feed_title": (getattr(parsed.feed, "title", "") or "").strip(),
        "entries": entries,
        "truncated": truncated,
    }


def _coerce_published(entry: Any) -> str:
    """Return an ISO-8601 UTC timestamp for a feed entry, or empty string."""
    for attr in ("published_parsed", "updated_parsed", "created_parsed"):
        t = getattr(entry, attr, None)
        if t is None:
            continue
        try:
            return datetime(*t[:6], tzinfo=timezone.utc).isoformat()
        except (TypeError, ValueError):
            continue
    raw = getattr(entry, "published", None) or getattr(entry, "updated", None)
    return str(raw) if raw else ""


# Prefect tasks and agent tool registration live in ../agents/discovery.py
# and ../flows/discovery_pipeline.py — keeping the tool itself import-free
# of Prefect decorators makes it unit-testable.
