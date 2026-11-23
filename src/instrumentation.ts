/**
 * Runs once when a server instance starts (Next.js instrumentation hook).
 *
 * Reports the TypeSafe decision layer's configuration (module 013) at
 * boot, so a bad TS_* value shows up in the service log when the
 * service restarts — not later, as a bot that quietly stopped screening.
 * It must never throw: under systemd's Restart=always a throw here would
 * crash-loop the whole CRM over one optional feature.
 *
 * First of all it puts the time in front of every log line
 * (`LOG_TIMESTAMPS=off` to leave them bare).
 *
 * It also starts the web push delivery loop (docs/push.md) in a
 * production server, under the same never-throw rule.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  await stampLogs();
  await reportTypeSafe();
  await reportPosture();
  await startPushDelivery();
}

/** Production only: a dev console already shows the time it needs. */
async function stampLogs() {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.LOG_TIMESTAMPS?.trim().toLowerCase() === 'off') return;
  try {
    const { installLogTimestamps } = await import('@/lib/log/timestamps');
    installLogTimestamps();
  } catch (err) {
    console.error('[log] timestamps not installed:', err);
  }
}

/** Which optional integrations are on, and which run on an untested wire format. */
async function reportPosture() {
  try {
    const { startupPosture, postureLogLine } =
      await import('@/lib/metrics/posture');
    const posture = startupPosture();
    const line = postureLogLine(posture);
    if (posture.some((i) => i.configured && i.unverified)) console.warn(line);
    else console.info(line);
  } catch (err) {
    console.error('[posture] could not report:', err);
  }
}

async function reportTypeSafe() {
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

const PUSH_LOOP_FLAG = Symbol.for('wacrm.pushLoopStarted');

/**
 * The web push delivery loop: one per production server process, only
 * when VAPID keys are set. Not awaited: the loop runs for the life of
 * the process, and register() must return before the server takes
 * requests. Dev servers (HMR re-runs register) rely on the automations
 * cron instead.
 */
async function startPushDelivery() {
  if (process.env.NODE_ENV !== 'production') return;
  try {
    const flags = globalThis as unknown as Record<symbol, boolean>;
    if (flags[PUSH_LOOP_FLAG]) return;
    const { pushConfig } = await import('@/lib/push/config');
    if (!pushConfig()) {
      console.info('[push] web push: off (VAPID keys not set)');
      return;
    }
    const [{ dispatchPush }, { startPushLoop }, { supabaseAdmin }] =
      await Promise.all([
        import('@/lib/push/dispatch'),
        import('@/lib/push/loop'),
        import('@/lib/flows/admin-client'),
      ]);
    if (flags[PUSH_LOOP_FLAG]) return;
    flags[PUSH_LOOP_FLAG] = true;
    startPushLoop(() => dispatchPush(supabaseAdmin()));
    console.info('[push] web push: delivery loop started');
  } catch (err) {
    console.error(
      `[push] delivery loop not started: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * One line per request that failed with an unhandled error: which route
 * and how, next to the stack Next prints. Never the query string (it can
 * carry a name or a number someone searched for).
 */
export function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routePath: string; routeType: string }
) {
  const digest = (err as { digest?: unknown } | null)?.digest;
  console.error(
    `[request-error] ${request.method} ${request.path.split('?')[0]} (${context.routeType} ${context.routePath})${
      typeof digest === 'string' ? ` digest ${digest}` : ''
    }`
  );
}
