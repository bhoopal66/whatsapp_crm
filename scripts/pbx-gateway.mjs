#!/usr/bin/env node
// Yeastar event gateway: holds the PBX's event WebSocket and forwards
// every frame to the app. Plain Node >= 22 (global WebSocket and fetch),
// no app imports. See docs/yeastar.md, "Running the gateway".
//
//   APP_URL=http://127.0.0.1:3000 PBX_GATEWAY_SECRET=... npm run pbx:gateway
//
// The app mints the PBX token and answers only the socket URL that
// embeds it: this process never sees the Client ID / Secret. The URL is
// never logged. A gap (any reconnect) is backfilled from call records.

const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const SECRET = process.env.PBX_GATEWAY_SECRET || '';
if (!APP_URL || !SECRET) {
  console.error('[pbx-gateway] APP_URL and PBX_GATEWAY_SECRET are required');
  process.exit(1);
}

const HEARTBEAT = 'heartbeat';
const HEARTBEAT_MS = 30_000; // half the PBX's 60 s idle timeout
const DEFAULT_REFRESH_MS = 25 * 60_000; // tokens live 30 minutes
const POST_RETRIES = 5;

let stopping = false;
let socket = null;
let heartbeatTimer = null;
let refreshTimer = null;
let wakeSleep = null;
/** When the last socket went down: the start of the gap to backfill. */
let gapFrom = null;

const log = (...a) =>
  console.log(new Date().toISOString(), '[pbx-gateway]', ...a);

/** Capped exponential backoff with equal jitter (as ws.ts nextBackoffMs). */
function backoffMs(attempt, baseMs = 1_000, maxMs = 60_000) {
  const step = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(step / 2 + (step / 2) * Math.random());
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeSleep = () => {
      clearTimeout(t);
      resolve();
    };
  });

async function post(path, body, contentType = 'application/json') {
  const res = await fetch(`${APP_URL}/api/pbx/gateway/${path}`, {
    method: 'POST',
    headers: { 'x-gateway-secret': SECRET, 'content-type': contentType },
    body,
    signal: AbortSignal.timeout(65_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function forward(frame) {
  for (let attempt = 0; ; attempt++) {
    try {
      await post('events', frame, 'text/plain');
      return;
    } catch (err) {
      if (attempt + 1 >= POST_RETRIES || stopping) {
        // Dropped here; the next backfill re-reads its call record.
        log('event not delivered:', err.message);
        return;
      }
      await sleep(backoffMs(attempt, 500, 10_000));
    }
  }
}

// Frames are forwarded one at a time, in order.
let queue = Promise.resolve();
const enqueue = (frame) => (queue = queue.then(() => forward(frame)));

async function backfill(from, to) {
  try {
    const r = await post('backfill', JSON.stringify({ from, to }));
    log(
      `backfilled ${r.from} .. ${r.to}: ${r.records} records, ${r.ingested} new`
    );
  } catch (err) {
    log('backfill failed:', err.message);
  }
}

function clearTimers() {
  clearInterval(heartbeatTimer);
  clearTimeout(refreshTimer);
  heartbeatTimer = refreshTimer = null;
}

/** Resolves when the socket closes; `planned` when we closed it to refresh. */
function connect(session) {
  return new Promise((resolve) => {
    let opened = false;
    let planned = false;
    const ws = new WebSocket(session.wsUrl);
    socket = ws;
    ws.addEventListener('open', () => {
      opened = true;
      ws.send(JSON.stringify({ topic_list: session.topics }));
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(HEARTBEAT);
      }, HEARTBEAT_MS);
      refreshTimer = setTimeout(() => {
        planned = true;
        ws.close(1000, 'token refresh');
      }, session.refreshAfterMs || DEFAULT_REFRESH_MS);
      log(`connected (connection ${session.connectionId})`);
      if (gapFrom) {
        const from = gapFrom;
        gapFrom = null;
        void backfill(from, new Date().toISOString());
      }
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      const text = ev.data.trim();
      if (text === 'heartbeat response') return;
      enqueue(ev.data);
    });
    ws.addEventListener('error', () => {
      // The close event follows; the URL is never logged (it holds a token).
    });
    ws.addEventListener('close', (ev) => {
      clearTimers();
      socket = null;
      if (opened) gapFrom ??= new Date().toISOString();
      if (!stopping && !planned) log(`socket closed (${ev.code})`);
      resolve({ planned, opened });
    });
  });
}

async function main() {
  let failures = 0;
  while (!stopping) {
    let session;
    try {
      session = await post('session', '');
    } catch (err) {
      log('session failed:', err.message);
      await sleep(backoffMs(failures++));
      continue;
    }
    const { planned, opened } = await connect(session);
    if (stopping) break;
    if (planned || opened) failures = 0;
    if (!planned) await sleep(backoffMs(failures++));
  }
  await queue;
  log('stopped');
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down`);
  clearTimers();
  wakeSleep?.();
  if (socket && socket.readyState <= WebSocket.OPEN)
    socket.close(1000, 'shutdown');
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[pbx-gateway] fatal:', err);
    process.exit(1);
  }
);
