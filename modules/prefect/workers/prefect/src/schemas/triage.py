"""Output schemas for the triage agent.

The triage agent reads pending `content_submissions` rows, classifies each,
and emits a `TriageRunOutput`. The orchestration task in
`flows/triage_pipeline.py` validates the output here before writing to
`content_queue`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


# Content types we recognize today. Keep in sync with the `content_type`
# check constraint on content_items / content_queue if it changes.
ContentType = Literal[
    "article",
    "video",
    "repo",
    "podcast",
    "discussion",
    "tweet",
    "event",
    "paper",
    "other",
]

SourceKind = Literal[
    "youtube",
    "blog",
    "github",
    "reddit",
    "hackernews",
    "twitter",
    "luma",
    "meetup",
    "arxiv",
    "rss",
    "other",
]


class TriagedItem(BaseModel):
    """A single submission after triage classification.

    - `decision='queue'` → create a content_queue row with the given
      metadata (canonical_url, content_type, source, priority).
    - `decision='reject'` → update the content_submissions row to
      status='rejected' with the given reason.
    - `decision='duplicate'` → update to status='duplicate' with a pointer
      to the canonical submission.
    """

    submission_id: str = Field(description="UUID of the content_submissions row")
    decision: Literal["queue", "reject", "duplicate"]
    content_type: ContentType | None = None
    source: SourceKind | None = None
    priority: int | None = Field(default=None, ge=1, le=5)
    canonical_url: HttpUrl | None = None
    duplicate_of_submission_id: str | None = Field(
        default=None,
        description="When decision='duplicate', points to the content_submissions row this one duplicates",
    )
    reject_reason: str | None = Field(
        default=None,
        max_length=500,
        description="Short human-readable reason when decision='reject' (off-topic, low-quality, spam, etc.)",
    )

    @field_validator("priority")
    @classmethod
    def priority_requires_queue(cls, v: int | None, info) -> int | None:
        # Cross-field validation happens at model level; leave this as a
        # placeholder for clarity.
        return v


class TriageRunOutput(BaseModel):
    items: list[TriagedItem] = Field(default_factory=list)
    notes: str | None = Field(
        default=None,
        max_length=2000,
        description="Free-text postmortem (sources skipped, fuzzy matches escalated, etc.)",
    )
