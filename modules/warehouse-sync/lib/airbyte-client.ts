/**
 * Minimal typed client for the Airbyte API (Option B control plane).
 *
 * Targets the supported **public** API (`/api/public/v1`) of a self-hosted
 * Airbyte, scoped to this instance's workspace. The module talks to the
 * in-cluster Airbyte's baseUrl for its workspaceId.
 *
 * No external deps: `fetch` is injected (defaults to globalThis.fetch) so this
 * file typechecks without DOM/node libs and is trivially testable.
 */

export interface AirbyteClientOptions {
  /** In-cluster base URL, e.g. http://airbyte-airbyte-server-svc.airbyte:8001 (NOT public). */
  baseUrl: string;
  /** Bearer token for the public API (from the LF secret store). */
  token?: string;
  /** This instance's workspace id — scopes every list call. */
  workspaceId: string;
  /** Injected fetch (defaults to global). */
  fetchFn?: FetchLike;
  /** Request timeout ms (default 15000). */
  timeoutMs?: number;
}

/** Structural subset of fetch we use — keeps the lib DOM/node-lib free. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export type JobStatus =
  | 'pending'
  | 'running'
  | 'incomplete'
  | 'failed'
  | 'succeeded'
  | 'cancelled';

export interface AirbyteConnectionSummary {
  connectionId: string;
  name: string;
  status: string; // active | inactive | deprecated
  sourceId: string;
  destinationId: string;
  scheduleType?: string;
}

export interface AirbyteJob {
  jobId: number;
  status: JobStatus;
  jobType: string; // sync | reset
  startTime?: string;
  lastUpdatedAt?: string;
  duration?: string;
  rowsSynced?: number;
  bytesSynced?: number;
}

export class AirbyteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class AirbyteClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly workspaceId: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: AirbyteClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.workspaceId = opts.workspaceId;
    const g = globalThis as unknown as { fetch?: FetchLike };
    const injected = opts.fetchFn ?? g.fetch;
    if (!injected) throw new AirbyteError('no fetch implementation available', 0);
    this.fetchFn = injected;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchFn(`${this.baseUrl}/api/public/v1${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AirbyteError(`Airbyte ${method} ${path} → ${res.status} ${detail.slice(0, 200)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Connections in this instance's workspace. */
  async listConnections(): Promise<AirbyteConnectionSummary[]> {
    const data = await this.request<{ data: AirbyteConnectionSummary[] }>(
      `/connections?workspaceIds=${encodeURIComponent(this.workspaceId)}`,
    );
    return data.data ?? [];
  }

  /** Recent jobs for a connection, newest first. */
  async listJobs(connectionId: string, limit = 10): Promise<AirbyteJob[]> {
    const data = await this.request<{ data: AirbyteJob[] }>(
      `/jobs?connectionId=${encodeURIComponent(connectionId)}&limit=${limit}&jobType=sync`,
    );
    return data.data ?? [];
  }

  /** Trigger a manual sync. Returns the created job. */
  async triggerSync(connectionId: string): Promise<AirbyteJob> {
    return this.request<AirbyteJob>('/jobs', 'POST', { connectionId, jobType: 'sync' });
  }

  async getJob(jobId: number): Promise<AirbyteJob> {
    return this.request<AirbyteJob>(`/jobs/${jobId}`);
  }
}

/** Build a client from module config (returns null when Airbyte isn't configured). */
export function airbyteClientFromConfig(
  cfg: Record<string, unknown>,
  fetchFn?: FetchLike,
): AirbyteClient | null {
  const baseUrl = (cfg.airbyteApiUrl as string) ?? '';
  const workspaceId = (cfg.airbyteWorkspaceId as string) ?? '';
  if (!baseUrl || !workspaceId) return null;
  return new AirbyteClient({
    baseUrl,
    workspaceId,
    token: (cfg.airbyteApiToken as string) || undefined,
    fetchFn,
  });
}
