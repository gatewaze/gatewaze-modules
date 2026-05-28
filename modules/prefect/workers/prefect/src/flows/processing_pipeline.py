"""Prefect `processing_pipeline` flow.

Drains pending `content_queue` rows every 5 minutes, runs the processing
agent, and inserts `content_items` (+ optional `content_segments`) based
on the agent's decisions.

Scheduled independently from discovery + triage (spec A.4.3: processing
every 5 min). Concurrency capped at 1 at the work-pool level.
"""

from __future__ import annotations

import time
from typing import Any

from prefect import flow, get_run_logger, task
from pydantic import ValidationError

from ..agents.processing import run_processing_agent
from ..clients.supabase import writer_client
from ..cost_guard import CostExceeded
from ..schemas.processing import ProcessedItem, ProcessingRunOutput


@task(name="run-processing-agent", retries=2, retry_delay_seconds=[30, 120])
async def processing_task(batch_size: int) -> ProcessingRunOutput:
    logger = get_run_logger()
    logger.info("processing: starting batch (size<=%s)", batch_size)
    return await run_processing_agent(batch_size=batch_size)


@task(name="persist-processed-items")
async def persist_processed_items(out: ProcessingRunOutput) -> dict[str, int]:
    """Apply each ProcessedItem's decision to the database.

    publish   → insert content_items row (+ content_segments if present)
                + update queue row to 'completed'.
    reject    → update queue row to 'rejected' with reason.
    duplicate → update queue row to 'duplicate' with pointer.
    """
    logger = get_run_logger()
    counts = {"published": 0, "rejected": 0, "duplicate": 0, "errors": 0}

    writer = writer_client()
    for item in out.items:
        try:
            _apply_processing_decision(writer, item)
            counts[_bucket_for_decision(item.decision)] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "processing: failed to apply %s for queue=%s: %s",
                item.decision, item.queue_id, exc,
            )
            counts["errors"] += 1
    return counts


def _bucket_for_decision(decision: str) -> str:
    return {"publish": "published", "reject": "rejected", "duplicate": "duplicate"}.get(
        decision, "errors"
    )


def _apply_processing_decision(writer, item: ProcessedItem) -> None:
    if item.decision == "publish":
        item_payload = {
            "source_url": str(item.canonical_url) if item.canonical_url else None,
            "title": item.title,
            "summary": item.summary,
            "hot_take": item.hot_take,
            "quality_score": item.quality_score,
            "projects_mentioned": item.projects_mentioned or [],
            "topics": item.topics or [],
            "author_name": item.author_name,
            "published_at": item.published_at,
            "status": "published",
        }
        result = writer.table("content_items").insert(item_payload).execute()
        new_item_id = (result.data or [{}])[0].get("id")

        # Emit chapter segments only when we actually captured the new item id.
        if new_item_id and item.segments:
            segment_rows = [
                {
                    "item_id": new_item_id,
                    "position": seg.position,
                    "start_seconds": seg.start_seconds,
                    "end_seconds": seg.end_seconds,
                    "title": seg.title,
                    "summary": seg.summary,
                    "tags": seg.tags,
                }
                for seg in item.segments
            ]
            writer.table("content_segments").insert(segment_rows).execute()

        writer.table("content_queue").update({"status": "completed"}).eq(
            "id", item.queue_id
        ).execute()
        return

    if item.decision == "reject":
        writer.table("content_queue").update(
            {"status": "failed", "rejection_reason": item.reject_reason}
        ).eq("id", item.queue_id).execute()
        return

    if item.decision == "duplicate":
        patch: dict[str, Any] = {"status": "duplicate"}
        if item.duplicate_of_item_id:
            patch["duplicate_of_item_id"] = item.duplicate_of_item_id
        writer.table("content_queue").update(patch).eq("id", item.queue_id).execute()
        return


@flow(name="content-processing", retries=0)
async def processing_pipeline(batch_size: int = 5) -> dict[str, Any]:
    """Drain pending queue items on the 5-minute cron."""
    logger = get_run_logger()
    logger.info("processing_pipeline: starting")

    metrics = {
        "items_processed": 0,
        "published": 0,
        "rejected": 0,
        "duplicate": 0,
        "errors": 0,
        "duration_ms": 0,
    }

    t0 = time.monotonic()
    try:
        out = await processing_task(batch_size)
        metrics["items_processed"] = len(out.items)

        if out.items:
            counts = await persist_processed_items(out)
            metrics.update(counts)

    except CostExceeded as exc:
        logger.error("processing cost budget exceeded: %s", exc)
        return {"status": "failed", "metrics": metrics, "error": str(exc)}
    except ValidationError as exc:
        logger.error("processing output failed schema validation: %s", exc)
        return {"status": "failed", "metrics": metrics, "error": f"validation_failed: {exc}"}
    except Exception as exc:  # noqa: BLE001
        logger.exception("processing_pipeline: unhandled error")
        return {"status": "failed", "metrics": metrics, "error": str(exc)}
    finally:
        metrics["duration_ms"] = int((time.monotonic() - t0) * 1000)

    return {"status": "completed", "metrics": metrics}
