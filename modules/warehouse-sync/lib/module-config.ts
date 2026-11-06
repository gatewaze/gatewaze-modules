/**
 * Module config loader for the warehouse-sync workers.
 *
 * The worker host does NOT populate `ctx.moduleConfig` — every other module in
 * this repo reads `installed_modules.config` directly (see videos,
 * videos-publisher-youtube, send-testing, event-agenda). Both warehouse-sync
 * workers relied on `ctx.moduleConfig` alone, so they silently ran with an
 * empty config: airbyte-status logged "Airbyte not configured" and skipped on
 * every tick despite airbyteApiUrl/airbyteWorkspaceId being set, and
 * slot-monitor fell back to default thresholds and the default slot name.
 *
 * Prefer the host-supplied config when it is actually populated (so a host that
 * does provide it keeps working), otherwise read the persisted row.
 *
 * ALERT CONFIG ALSO COMES FROM THE ENVIRONMENT (2026-11-06). Everything above
 * lives only in a database row edited through the admin UI, which is invisible
 * to code review, absent from a fresh clone and lost on a restore. That is why
 * `alertWebhookUrl` was still unset through four slot-loss incidents: nobody
 * could see that it was missing. The keys that decide whether an alert reaches
 * a human now have an environment fallback, so a deploy from git always has
 * working alerting instead of depending on a row someone remembered to set.
 *
 * `alertWebhookUrl` and `heartbeatUrl` are credentials — a ping or incoming
 * webhook URL is bearer-equivalent. They go through gatewaze-environments'
 * SOPS-encrypted path and reach the pod by secretKeyRef, never as a plaintext
 * values entry. The non-secret keys (thresholds) can sit in plain values.
 *
 * Precedence is database over environment, so the admin UI can still override
 * at runtime, but an unset row no longer means silence.
 */

export type ModuleConfig = Record<string, unknown>;

/**
 * Config keys readable from the environment, mapped to their env var name.
 * Deliberately narrow: only the keys that govern alert delivery and the
 * thresholds that decide when to alert.
 */
export const ENV_CONFIG_KEYS: Record<string, string> = {
  alertWebhookUrl: 'WAREHOUSE_SYNC_ALERT_WEBHOOK_URL',
  alertSlackChannel: 'WAREHOUSE_SYNC_ALERT_SLACK_CHANNEL',
  retainedWalAlertGb: 'WAREHOUSE_SYNC_RETAINED_WAL_ALERT_GB',
  syncSilenceAlertHours: 'WAREHOUSE_SYNC_SILENCE_ALERT_HOURS',
  heartbeatUrl: 'WAREHOUSE_SYNC_HEARTBEAT_URL',
};

/** Read the env-var fallbacks. Exported for testing. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ModuleConfig {
  const out: ModuleConfig = {};
  for (const [key, envName] of Object.entries(ENV_CONFIG_KEYS)) {
    const v = env[envName];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return out;
}

/** Load warehouse-sync's persisted config, preferring a populated ctx.moduleConfig. */
export async function loadModuleConfig(
  supabase: { from: (t: string) => any },
  ctx?: { moduleConfig?: ModuleConfig; logger?: { warn?: (m: string) => void } },
  moduleId = 'warehouse-sync',
): Promise<ModuleConfig> {
  const fromEnv = configFromEnv();

  const fromCtx = (ctx?.moduleConfig ?? {}) as ModuleConfig;
  if (Object.keys(fromCtx).length > 0) return { ...fromEnv, ...fromCtx };

  try {
    const { data, error } = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', moduleId)
      .maybeSingle();
    if (error) {
      ctx?.logger?.warn?.(`[${moduleId}] could not load installed_modules config: ${error.message}`);
      return fromEnv;
    }
    return { ...fromEnv, ...((data?.config ?? {}) as ModuleConfig) };
  } catch (e) {
    ctx?.logger?.warn?.(`[${moduleId}] could not load installed_modules config: ${(e as Error)?.message ?? e}`);
    return fromEnv;
  }
}
