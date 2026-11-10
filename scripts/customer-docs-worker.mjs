#!/usr/bin/env node
// Customer documents NAS copier: copies every document/photo a customer
// sent into its folder on the Synology share. Its own systemd service
// (scripts/systemd/wacrm-customer-docs.service), never the Next.js app:
// the share is a `hard` CIFS mount and a NAS outage blocks file I/O.
// All logic is in src/lib/customer-docs/nas-worker.ts, which plain
// Node >= 22.18 loads with type stripping.
//
//   node scripts/customer-docs-worker.mjs           # run until SIGTERM
//   node scripts/customer-docs-worker.mjs --once    # one batch; exit 1 if anything failed
//
// Exit 2: missing or invalid configuration.

// The repo's package.json has no "type", so Node warns on every start
// that it re-parsed the .ts module as ESM. Drop that one warning (the
// default printer is a 'warning' listener), keep every other, then
// load the module.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code !== 'MODULE_TYPELESS_PACKAGE_JSON')
    console.error(String(w.stack || w));
});
const { loadConfig, runWorker } =
  await import('../src/lib/customer-docs/nas-worker.ts');

const once = process.argv.includes('--once');
const loaded = loadConfig(process.env);
if ('error' in loaded) {
  console.error(`[customer-docs] ${loaded.error}`);
  process.exit(2);
}

const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stop.signal.aborted) return;
    console.log(
      `${new Date().toISOString()} [customer-docs] ${sig}: stopping after the current file`
    );
    stop.abort();
  });
}

const { exitCode } = await runWorker(loaded.config, {
  once,
  signal: stop.signal,
});
process.exit(exitCode);
