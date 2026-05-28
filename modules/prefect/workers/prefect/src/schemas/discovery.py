"""Output schemas for the discovery agent.

The discovery agent returns a list of candidate content submissions
(one per URL it found). Each submission is validated against
`DiscoveredItem` before insert.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


class DiscoveredItem(BaseModel):
    """A single candidate URL + metadata discovered from a source.

    The agent emits many of these per run. Anything that fails validation
    is dropped and logged; the remainder are written to content_submissions
    with the agent_writer role.
    """

    url: HttpUrl
    title: str = Field(min_length=1, max_length=500)
    source_id: str = Field(description="UUID of the content_discovery_sources row")
    extracted_text: str | None = Field(default=None, max_length=50_000)
    discovered_at: datetime
    projects_mentioned: list[Literal["mcp", "goose", "agents_md"]] = Field(default_factory=list)

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("title cannot be blank")
        return stripped


class DiscoveryRunOutput(BaseModel):
    """Final structured output of a discovery_pipeline run's discovery stage."""

    items: list[DiscoveredItem] = Field(default_factory=list)
    items_rejected: int = Field(
        default=0,
        description="Count of candidates the agent considered but filtered out (off-topic, duplicate, etc.)",
    )
    notes: str | None = Field(
        default=None,
        max_length=2000,
        description="Free-text postmortem the agent can emit about the run (rate limits hit, sources skipped, etc.)",
    )
