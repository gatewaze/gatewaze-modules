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
 */

export type ModuleConfig = Record<string, unknown>;

/** Load warehouse-sync's persisted config, preferring a populated ctx.moduleConfig. */
export async function loadModuleConfig(
  supabase: { from: (t: string) => any },
  ctx?: { moduleConfig?: ModuleConfig; logger?: { warn?: (m: string) => void } },
  moduleId = 'warehouse-sync',
): Promise<ModuleConfig> {
  const fromCtx = (ctx?.moduleConfig ?? {}) as ModuleConfig;
  if (Object.keys(fromCtx).length > 0) return fromCtx;

  try {
    const { data, error } = await supabase
      .from('installed_modules')
      .select('config')
      .eq('id', moduleId)
      .maybeSingle();
    if (error) {
      ctx?.logger?.warn?.(`[${moduleId}] could not load installed_modules config: ${error.message}`);
      return {};
    }
    return (data?.config ?? {}) as ModuleConfig;
  } catch (e) {
    ctx?.logger?.warn?.(`[${moduleId}] could not load installed_modules config: ${(e as Error)?.message ?? e}`);
    return {};
  }
}
