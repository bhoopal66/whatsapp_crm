/**
 * Runs once when a server instance starts (Next.js instrumentation hook).
 *
 * Reports the TypeSafe decision layer's configuration (module 013) at
 * boot, so a bad TS_* value shows up in the service log when the
 * service restarts — not later, as a bot that quietly stopped screening.
 * It must never throw: under systemd's Restart=always a throw here would
 * crash-loop the whole CRM over one optional feature.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const { loadConfig, CHECK_NAMES, isShadow } =
      await import('@/lib/typesafe/config');
    const config = loadConfig();
    const available = CHECK_NAMES.filter((c) => config.enabled[c]);
    if (available.length === 0) {
      console.info(
        process.env.TYPESAFE_API_KEY?.trim()
          ? '[ts013] TypeSafe decision layer: off (every check disabled by TS_ENABLED_*=false)'
          : '[ts013] TypeSafe decision layer: off (no TYPESAFE_API_KEY on this server)'
      );
      return;
    }
    const checks = available
      .map((c) => `${c}${isShadow(config, c) ? ' (forced monitor-only)' : ''}`)
      .join(', ');
    const accounts =
      config.accounts === '*'
        ? 'any account'
        : `${config.accounts.length} account(s) only`;
    console.info(
      `[ts013] TypeSafe decision layer: available for ${accounts} (${checks}); each account switches it on in Settings → AI Agents → Safety checks; model ${config.model}; guardrail fail mode ${config.guardrailFailMode}`
    );
  } catch (err) {
    console.error(
      `[ts013] error CONFIG_INVALID: the TypeSafe layer is OFF until this is fixed and the service restarted — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
