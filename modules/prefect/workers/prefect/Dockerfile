# syntax=docker/dockerfile:1.7

# ---------- Base stage: Python 3.11 + build deps ----------
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install system deps. feedparser doesn't need anything; claude-agent-sdk
# may need a build toolchain for its native deps on some versions, so we
# keep gcc available in the build stage and drop it in the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      libpq5 \
 && rm -rf /var/lib/apt/lists/*

# ---------- Dependencies stage (cached separately from source) ----------
FROM base AS deps

COPY pyproject.toml ./
RUN pip install --upgrade pip \
 && pip install hatchling \
 && pip install --prefix=/install .

# ---------- Runtime stage ----------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/install/bin:${PATH}"

# Runtime system deps only — no compiler
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libpq5 \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy installed site-packages + console scripts from deps stage
COPY --from=deps /install /install

WORKDIR /app
COPY src/ ./src/
COPY pyproject.toml README.md ./

# Non-root runtime
RUN groupadd --system worker \
 && useradd --system --gid worker --no-create-home worker \
 && chown -R worker:worker /app
USER worker

# Default command runs the worker. The deployment-time registration step
# is a one-shot job that uses the same image with `register` as the arg.
CMD ["python", "-m", "src.main", "worker"]
