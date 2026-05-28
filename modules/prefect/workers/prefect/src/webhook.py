"""Worker-to-Gatewaze status webhook client.

The Prefect worker calls back into the Gatewaze `content-discovery`
module's `/webhook` endpoint after each run (spec C.3.5.3). The callback
is signed with HMAC-SHA256 using PREFECT_WEBHOOK_SECRET.

Payload shape matches the spec exactly.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any

import httpx

from .config import load_config


def _sign(secret: str, body: bytes) -> str:
    mac = hmac.new(secret.encode("utf-8"), body, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


async def send_status(
    *,
    endpoint_path: str,
    idempotency_key: str,
    prefect_flow_run_id: str,
    status: str,
    metrics: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> None:
    """POST a signed status update back to Gatewaze.

    `endpoint_path` is module-scoped (e.g. `/api/modules/content-discovery/webhook`).
    Errors are logged but never raised — a failed callback must not fail
    the flow run.
    """
    cfg = load_config()
    base = cfg.webhook.gatewaze_base_url.rstrip("/")
    url = f"{base}{endpoint_path}"

    payload: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "idempotency_key": idempotency_key,
        "prefect_flow_run_id": prefect_flow_run_id,
        "status": status,
    }
    if metrics is not None:
        payload["metrics"] = metrics
    if error is not None:
        payload["error"] = error

    # Canonical JSON serialization so the HMAC the receiver computes over
    # the raw body matches what we signed here. Do NOT rely on httpx's
    # re-serialization (key ordering may differ).
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = _sign(cfg.webhook.secret, body)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                url,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Prefect-Signature": signature,
                },
            )
            if resp.status_code >= 400:
                # Log-and-continue; the run's state of record is the
                # content_discovery_runs row, which the orchestrator also
                # updates directly as a belt-and-braces safety net.
                import logging

                logging.getLogger(__name__).warning(
                    "webhook POST %s returned %s: %s",
                    url,
                    resp.status_code,
                    resp.text[:500],
                )
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning("webhook POST %s failed: %s", url, exc)
