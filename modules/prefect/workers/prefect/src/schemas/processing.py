"""Output schemas for the processing agent.

The processing agent reads pending `content_queue` rows, scrapes each URL,
generates summary/hot_take/quality_score, tags with taxonomy, and emits a
`ProcessingRunOutput`. The orchestration task in
`flows/processing_pipeline.py` validates the output here before writing to
`content_items` (and optionally `content_segments` for media with transcripts).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator


class ContentSegment(BaseModel):
    """A single chapter / segment of a video or podcast transcript.

    Only emitted when the processing agent had access to a usable
    transcript. Bounded per spec A.7 #7 (3–15 segments per item).
    """

    position: int = Field(ge=0, description="0-indexed position within the item")
    start_seconds: int = Field(ge=0)
    end_seconds: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("end_seconds")
    @classmethod
    def end_after_start(cls, v: int, info) -> int:
        start = info.data.get("start_seconds", 0)
        if v <= start:
            raise ValueError("end_seconds must be greater than start_seconds")
        return v


class ProcessedItem(BaseModel):
    """A single queue item after full processing.

    - `decision='publish'` → insert into content_items with all metadata.
    - `decision='reject'` → update the content_queue row to
      status='rejected' with reason.
    - `decision='duplicate'` → update to status='duplicate'.
    """

    queue_id: str = Field(description="UUID of the content_queue row")
    decision: Literal["publish", "reject", "duplicate"]

    # Populated when decision='publish'
    canonical_url: HttpUrl | None = None
    title: str | None = Field(default=None, max_length=500)
    summary: str | None = Field(
        default=None,
        max_length=2000,
        description="2-4 sentences per spec A.7 #3",
    )
    hot_take: str | None = Field(
        default=None,
        max_length=1000,
        description="Opinionated significance statement per spec A.7 #3",
    )
    quality_score: float | None = Field(default=None, ge=0.1, le=1.0)
    projects_mentioned: list[Literal["mcp", "goose", "agents_md"]] = Field(default_factory=list)
    topics: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="Topic slugs from content_topic_taxonomy",
    )
    author_name: str | None = Field(default=None, max_length=200)
    published_at: str | None = Field(
        default=None,
        description="ISO 8601 when the source was originally published",
    )
    segments: list[ContentSegment] = Field(
        default_factory=list,
        max_length=15,
        description="Optional chapter segments for video/podcast items (spec A.7 #7)",
    )

    # Populated when decision != 'publish'
    duplicate_of_item_id: str | None = None
    reject_reason: str | None = Field(default=None, max_length=500)

    @field_validator("segments")
    @classmethod
    def segments_ordered(cls, v: list[ContentSegment]) -> list[ContentSegment]:
        for i, s in enumerate(v):
            if s.position != i:
                raise ValueError(f"segments must have sequential positions starting at 0; got {s.position} at index {i}")
        return v


class ProcessingRunOutput(BaseModel):
    items: list[ProcessedItem] = Field(default_factory=list)
    notes: str | None = Field(default=None, max_length=2000)
