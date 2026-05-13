/**
 * LISTEN gatewaze.mutation worker.
 *
 * Holds a long-lived pg client subscribed to the mutation channel. On
 * NOTIFY, parses the payload and enqueues into the WebhookHub. Reconnect
 * with exponential backoff (1s, 2s, 4s, 8s capped at 30s) per spec §4.5;
 * recovery sweep on (re)connect picks up any in-flight deliveries.
 *
 * Module-author note: the `pg` package is a peer dep that may or may not
 * already be hoisted into the api container's node_modules. The platform's
 * supabase-js stack already brings node-postgres transitively, so this
 * import resolves at runtime; we tolerate a missing module by logging and
 * disabling the worker (Phase 2 of the spec deliberately tolerates a
 * degraded mode — themes still work via TTL revalidation).
 */

import type { MutationEvent, WebhookHub } from './webhook-hub.js';

export interface ListenWorkerOptions {
  connectionString: string;
  hub: WebhookHub;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Override the pg.Client constructor — used in tests. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ClientImpl?: any;
  /** Override delay between reconnects. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Optional bail-out — useful for tests. */
  signal?: AbortSignal;
}

const CHANNEL = 'gatewaze.mutation';

export class ListenWorker {
  private readonly opts: ListenWorkerOptions;
  private backoffMs: number;
  private readonly maxBackoffMs: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private stopped = false;

  constructor(opts: ListenWorkerOptions) {
    this.opts = opts;
    this.backoffMs = opts.initialBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  /**
   * Start the worker. Returns once the initial connection is established
   * (or fails to establish — the reconnect loop runs in the background).
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('worker already stopped');
    if (this.opts.signal?.aborted) {
      this.stopped = true;
      return;
    }
    this.opts.signal?.addEventListener('abort', () => {
      void this.stop();
    });
    await this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // intentional swallow — already disconnected
      }
      this.client = null;
    }
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connect();
        // Connect succeeded — reset backoff for the next disconnect.
        this.backoffMs = this.opts.initialBackoffMs ?? 1000;
        await this.runRecoverySweep();
        return;
      } catch (err) {
        this.opts.logger.warn('webhooks.listen_connect_failed', {
          error: err instanceof Error ? err.message : String(err),
          retry_in_ms: this.backoffMs,
        });
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      }
    }
  }

  private async connect(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ClientImpl: any = this.opts.ClientImpl;
    if (!ClientImpl) {
      throw new Error(
        'pg.Client constructor not provided. The webhooks module entry point ' +
        'must pass a ClientImpl from the api process (which has @gatewaze/api '
        + 'workspace deps); this lib cannot resolve `pg` from its own location.',
      );
    }
    const client = new ClientImpl({ connectionString: this.opts.connectionString });
    await client.connect();
    client.on('notification', (msg: { channel?: string; payload?: string }) => {
      if (msg.channel && msg.channel !== CHANNEL && msg.channel !== `"${CHANNEL}"`) return;
      this.handleNotification(msg.payload);
    });
    client.on('error', (err: unknown) => {
      this.opts.logger.warn('webhooks.listen_client_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.handleDisconnect();
    });
    client.on('end', () => {
      this.opts.logger.info('webhooks.listen_client_end');
      this.handleDisconnect();
    });
    // Postgres requires the channel to be quoted because it has a dot in it.
    await client.query(`LISTEN "${CHANNEL}"`);
    this.client = client;
    this.opts.logger.info('webhooks.listen_connected', { channel: CHANNEL });
  }

  private handleNotification(rawPayload: string | undefined): void {
    if (!rawPayload) return;
    let event: MutationEvent;
    try {
      event = JSON.parse(rawPayload) as MutationEvent;
    } catch (err) {
      this.opts.logger.warn('webhooks.listen_parse_failed', {
        error: err instanceof Error ? err.message : String(err),
        raw_length: rawPayload.length,
      });
      return;
    }
    if (!event.topic || !event.op || !event.host_kind || !event.host_id) {
      this.opts.logger.warn('webhooks.listen_event_malformed', { event });
      return;
    }
    this.opts.hub.enqueue(event);
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    if (this.client) {
      try {
        this.client.removeAllListeners?.();
      } catch {
        // ignore
      }
      this.client = null;
    }
    void this.connectLoop();
  }

  private async runRecoverySweep(): Promise<void> {
    try {
      await this.opts.hub.runRecoverySweep();
    } catch (err) {
      this.opts.logger.warn('webhooks.recovery_sweep_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
