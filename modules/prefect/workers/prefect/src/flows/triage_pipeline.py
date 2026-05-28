"""Prefect `triage_pipeline` flow.

Drains pending `content_submissions` rows every 5 minutes, runs the
triage agent, and writes `content_queue` rows (or updates the submission
to 'rejected' / 'duplicate') based on the agent's decisions.

Scheduled independently from discovery (spec A.4.3: triage every 5 min).
Concurrency is capped at 1 at the work-pool level so we don't double-
process the same batch across replicas.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from prefect import flow, get_run_logger, task
from pydantic import ValidationError

from ..agents.triage import run_triage_agent
from ..clients.supabase import writer_client
from ..cost_guard import CostExceeded
from ..schemas.triage import TriagedItem, TriageRunOutput


@task(name="run-triage-agent", retries=2, retry_delay_seconds=[30, 120])
async def triage_task(batch_size: int) -> TriageRunOutput:
    logger = get_run_logger()
    logger.info("triage: starting batch (size<=%s)", batch_size)
    return await run_triage_agent(batch_size=batch_size)


@task(name="persist-triage-items")
async def persist_triage_items(out: TriageRunOutput) -> dict[str, int]:
    """Apply each TriagedItem's decision to the database.

    `queue`     → insert content_queue row + update submission to
                  status='triaged'.
    `reject`    → update submission to status='rejected' with reason.
    `duplicate` → update submission to status='duplicate' with pointer.
    """
    logger = get_run_logger()
    counts = {"queued": 0, "rejected": 0, "duplicate": 0, "errors": 0}

    writer = writer_client()
    for item in out.items:
        try:
            _apply_triage_decision(writer, item)
            counts[_bucket_for_decision(item.decision)] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("triage: failed to apply %s for %s: %s", item.decision, item.submission_id, exc)
            counts["errors"] += 1
    return counts


def _bucket_for_decision(decision: str) -> str:
    return {"queue": "queued", "reject": "rejected", "duplicate": "duplicate"}.get(decision, "errors")


def _apply_triage_decision(writer, item: TriagedItem) -> None:
    """Write the agent's triage decision to the database."""
    if item.decision == "queue":
        # Create the queue row first so we never leave a submission in
        # 'triaged' state without a corresponding queue entry.
        writer.table("content_queue").insert(
            {
                "submission_id": item.submission_id,
                "url": str(item.canonical_url) if item.canonical_url else None,
                "content_type": item.content_type,
                "source": item.source,
                "priority": item.priority,
                "status": "pending",
            }
        ).execute()
        writer.table("content_submissions").update({"status": "triaged"}).eq(
            "id", item.submission_id
        ).execute()
        return

    if item.decision == "reject":
        writer.table("content_submissions").update(
            {"status": "failed", "rejection_reason": item.reject_reason}
        ).eq("id", item.submission_id).execute()
        return

    if item.decision == "duplicate":
        patch: dict[str, Any] = {"status": "duplicate"}
        if item.duplicate_of_submission_id:
            patch["duplicate_of_submission_id"] = item.duplicate_of_submission_id
        writer.table("content_submissions").update(patch).eq(
            "id", item.submission_id
        ).execute()
        return


@flow(name="content-triage", retries=0)
async def triage_pipeline(batch_size: int = 20) -> dict[str, Any]:
    """Drain pending submissions on the 5-minute cron."""
    logger = get_run_logger()
    logger.info("triage_pipeline: starting")

    metrics = {
        "items_triaged": 0,
        "queued": 0,
        "rejected": 0,
        "duplicate": 0,
        "errors": 0,
        "duration_ms": 0,
    }

    t0 = time.monotonic()
    try:
        out = await triage_task(batch_size)
        metrics["items_triaged"] = len(out.items)

        if out.items:
            counts = await persist_triage_items(out)
            metrics.update(counts)

    except CostExceeded as exc:
        logger.error("triage cost budget exceeded: %s", exc)
        return {"status": "failed", "metrics": metrics, "error": str(exc)}
    except ValidationError as exc:
        logger.error("triage output failed schema validation: %s", exc)
        return {"status": "failed", "metrics": metrics, "error": f"validation_failed: {exc}"}
    except Exception as exc:  # noqa: BLE001
        logger.exception("triage_pipeline: unhandled error")
        return {"status": "failed", "metrics": metrics, "error": str(exc)}
    finally:
        metrics["duration_ms"] = int((time.monotonic() - t0) * 1000)

    return {"status": "completed", "metrics": metrics}
