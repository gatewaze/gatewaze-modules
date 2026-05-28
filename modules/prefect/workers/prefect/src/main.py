"""Worker entrypoint.

Run as:
    python -m src.main worker     # start the Prefect worker (long-running)
    python -m src.main register   # register flow deployments (one-shot, at deploy time)

The `register` command pushes the flow deployments to Prefect Server. It
runs once during initial Helm install and again on version bumps. It
prints the deployment IDs so they can be propagated to the subchart's
`server.discoveryDeploymentId` value (which the core Gatewaze chart
consumes via extraEnvFrom so the content-discovery module can target the
correct deployment for admin-initiated runs).
"""

from __future__ import annotations

import asyncio
import os
import sys

from .flows.discovery_pipeline import discovery_pipeline
from .flows.processing_pipeline import processing_pipeline
from .flows.triage_pipeline import triage_pipeline

# Cron expressions match spec A.4.3 and the old Helix schedules.
DISCOVERY_CRON = "0 * * * *"      # hourly
TRIAGE_CRON = "*/5 * * * *"        # every 5 min
PROCESSING_CRON = "*/5 * * * *"    # every 5 min

WORK_POOL_NAME = os.environ.get("PREFECT_WORK_POOL", "gatewaze-default")


async def _register() -> None:
    """Push all three flow deployments to the Prefect Server.

    Each deployment carries its own cron schedule. Work-pool concurrency
    limits (configured at pool creation time, not here) keep triage +
    processing to one-run-at-a-time across replicas.
    """
    discovery_id = await discovery_pipeline.deploy(  # type: ignore[attr-defined]
        name="content-discovery-scheduled",
        work_pool_name=WORK_POOL_NAME,
        cron=DISCOVERY_CRON,
        parameters={"idempotency_key": "sched:auto", "source_id": None, "dry_run": False},
        description="Scheduled content discovery run (hourly). Spec A.4.3.",
    )
    print(f"discovery_pipeline deployment_id={discovery_id}")

    triage_id = await triage_pipeline.deploy(  # type: ignore[attr-defined]
        name="content-triage-scheduled",
        work_pool_name=WORK_POOL_NAME,
        cron=TRIAGE_CRON,
        parameters={"batch_size": 20},
        description="Drain pending submissions every 5 minutes. Spec A.6.",
    )
    print(f"triage_pipeline deployment_id={triage_id}")

    processing_id = await processing_pipeline.deploy(  # type: ignore[attr-defined]
        name="content-processing-scheduled",
        work_pool_name=WORK_POOL_NAME,
        cron=PROCESSING_CRON,
        parameters={"batch_size": 5},
        description="Drain pending queue items every 5 minutes. Spec A.7.",
    )
    print(f"processing_pipeline deployment_id={processing_id}")

    print(
        "\nSet `server.discoveryDeploymentId` in the prefect-worker subchart "
        "values to the discovery_pipeline deployment_id above, then "
        "`helm upgrade` so the ConfigMap picks it up and propagates into "
        "core Gatewaze pods (via extraEnvFrom) — that is how the "
        "content-discovery module's /trigger endpoint knows which "
        "deployment to target for admin-initiated runs."
    )


def _start_worker() -> None:
    """Start the Prefect worker process.

    We shell out to the Prefect CLI rather than reimplementing worker
    bootstrap in Python — the CLI handles heartbeats, graceful shutdown,
    and flow-run leasing correctly.
    """
    import subprocess

    cmd = ["prefect", "worker", "start", "--pool", WORK_POOL_NAME, "--type", "process"]
    os.execvp(cmd[0], cmd)  # replaces current process, no subprocess wrapper


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)

    verb = sys.argv[1]
    if verb == "register":
        asyncio.run(_register())
    elif verb == "worker":
        _start_worker()
    else:
        print(f"Unknown command: {verb!r}")
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
