"""Prefect `discovery_pipeline` flow.

Discovers new content candidates and persists them to
`content_submissions`. Does NOT call triage or processing — those run
as their own scheduled flows (spec A.4.3).

Triggered by:
  - Prefect scheduler (hourly cron in the deployment definition), or
  - Admin-initiated run via the content-discovery module's /trigger
    endpoint, which calls Prefect Server's `create_flow_run` API.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from prefect import flow, get_run_logger, task
from pydantic import ValidationError

from ..agents.discovery import run_discovery_agent
from ..clients.supabase import service_client, writer_client
from ..cost_guard import CostExceeded
from ..schemas.discovery import DiscoveryRunOutput
from ..webhook import send_status

_DISCOVERY_WEBHOOK_PATH = "/api/modules/content-discovery/webhook"


@task(name="run-discovery-agent", retries=2, retry_delay_seconds=[30, 120])
async def discovery_task(source_ids: list[str] | None, user_instruction: str) -> DiscoveryRunOutput:
    logger = get_run_logger()
    logger.info("discovery: starting (%s sources)", len(source_ids) if source_ids else "all")
    return await run_discovery_agent(
        source_ids=source_ids,
        user_instruction=user_instruction,
    )


@task(name="persist-discovery-items")
async def persist_discovery_items(out: DiscoveryRunOutput, *, idempotency_key_prefix: str) -> int:
    """Write validated items to content_submissions via the agent_writer role."""
    logger = get_run_logger()
    if not out.items:
        logger.info("persist: no items to write")
        return 0

    writer = writer_client()
    inserted = 0
    for idx, item in enumerate(out.items):
        item_key = f"{idempotency_key_prefix}:item:{idx}:{hash(str(item.url)) & 0xFFFFFFFF:08x}"
        payload = {
            "url": str(item.url),
            "title": item.title,
            "source_id": item.source_id,
            "status": "pending",
            "idempotency_key": item_key,
            "extracted_text": item.extracted_text,
        }
        try:
            writer.table("content_submissions").insert(payload).execute()
            inserted += 1
        except Exception as exc:  # noqa: BLE001
            # Unique-key conflict on idempotency_key is expected on retry.
            logger.warning("persist: failed to insert %s: %s", item.url, exc)
    return inserted


@flow(name="content-discovery", retries=0)
async def discovery_pipeline(
    source_id: str | None = None,
    idempotency_key: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Discovery-only flow. Triage + processing run on their own schedules."""
    logger = get_run_logger()
    logger.info(
        "discovery_pipeline: source_id=%s idempotency_key=%s dry_run=%s",
        source_id, idempotency_key, dry_run,
    )

    if idempotency_key is None:
        raise ValueError("idempotency_key is required (supplied by scheduler or trigger API)")

    source_ids = [source_id] if source_id else None

    await send_status(
        endpoint_path=_DISCOVERY_WEBHOOK_PATH,
        idempotency_key=idempotency_key,
        prefect_flow_run_id=_current_flow_run_id(),
        status="running",
    )

    metrics = {
        "items_discovered": 0,
        "items_rejected": 0,
        "duration_ms": 0,
        "cost_usd": 0.0,
    }
    status = "completed"
    error_payload: dict[str, Any] | None = None

    t0 = time.monotonic()
    try:
        out = await discovery_task(source_ids, user_instruction="")
        metrics["items_discovered"] = len(out.items)
        metrics["items_rejected"] = out.items_rejected

        if dry_run:
            logger.info("dry_run: skipping persistence")
        else:
            await persist_discovery_items(out, idempotency_key_prefix=idempotency_key)

    except CostExceeded as exc:
        logger.error("cost budget exceeded: %s", exc)
        status = "failed"
        error_payload = {
            "type": "cost_exceeded",
            "message": str(exc),
            "stage": exc.stage,
            "retryable": False,
        }
    except ValidationError as exc:
        logger.error("agent output failed schema validation: %s", exc)
        status = "failed"
        error_payload = {
            "type": "validation_failed",
            "message": str(exc)[:1000],
            "stage": "discovery",
            "retryable": False,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("discovery_pipeline: unhandled error")
        status = "failed"
        error_payload = {
            "type": "internal",
            "message": str(exc)[:1000],
            "stage": "discovery",
            "retryable": True,
        }
    finally:
        metrics["duration_ms"] = int((time.monotonic() - t0) * 1000)

        # Double-stamp the run row directly — the webhook is a nice-to-have,
        # the DB row is the source of truth.
        try:
            service_client().table("content_discovery_runs").update(
                {
                    "status": status,
                    "items_found": metrics["items_discovered"],
                    "items_submitted": metrics["items_discovered"] - metrics["items_rejected"],
                }
            ).eq("idempotency_key", idempotency_key).execute()
        except Exception as exc:  # noqa: BLE001
            logging.getLogger(__name__).warning("failed to stamp discovery_run row: %s", exc)

        await send_status(
            endpoint_path=_DISCOVERY_WEBHOOK_PATH,
            idempotency_key=idempotency_key,
            prefect_flow_run_id=_current_flow_run_id(),
            status=status,
            metrics=metrics,
            error=error_payload,
        )

    return {"status": status, "metrics": metrics, "error": error_payload}


def _current_flow_run_id() -> str:
    """Best-effort current flow-run id for webhook correlation."""
    try:
        from prefect.context import FlowRunContext

        ctx = FlowRunContext.get()
        if ctx and ctx.flow_run:
            return str(ctx.flow_run.id)
    except Exception:  # noqa: BLE001
        pass
    return "unknown"
