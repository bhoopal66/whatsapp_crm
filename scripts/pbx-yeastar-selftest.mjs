#!/usr/bin/env node
// Self-test of the Yeastar webhook: posts sample events (ringing, answered,
// call end, then a missed call) to POST /api/pbx/yeastar/events/{token} and
// prints pass/fail per step from the HTTP answers. See docs/yeastar.md.
//
//   PBX_WEBHOOK_SECRET=... node scripts/pbx-yeastar-selftest.mjs \
//     --base-url https://crm.example.com --token <path token>
//
// Env fallbacks: SELFTEST_BASE_URL, PBX_WEBHOOK_TOKEN, PBX_WEBHOOK_SECRET.
// Prefer the secret from the environment: an argument shows in `ps`.
// Nothing secret is printed; the token is shown masked. Node 20+, no deps.
import { createHmac, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node scripts/pbx-yeastar-selftest.mjs [options]

Posts sample Yeastar events (ringing, answered, call end, missed call) to
this app's webhook and reports pass/fail per step.

Options:
  --base-url <url>   App origin (env SELFTEST_BASE_URL)
  --token <token>    The connection's webhook path token (env PBX_WEBHOOK_TOKEN)
  --secret <secret>  The webhook's 32-character secret (env PBX_WEBHOOK_SECRET)
  --caller <number>  Customer number used in the samples (default 971501234567)
  --extension <ext>  Extension that takes the call (default 1001)
  -h, --help         Show this help

The samples create a real call record for the caller number: use a test
number. Exit code 0 when every step passes, 1 otherwise, 2 on bad usage.`;

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    token: { type: 'string' },
    secret: { type: 'string' },
    caller: { type: 'string', default: '971501234567' },
    extension: { type: 'string', default: '1001' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const baseUrl = values['base-url'] ?? process.env.SELFTEST_BASE_URL;
const token = values.token ?? process.env.PBX_WEBHOOK_TOKEN;
const secret = values.secret ?? process.env.PBX_WEBHOOK_SECRET;
if (!baseUrl || !token || !secret) {
  console.error('Missing base URL, token or secret.\n\n' + USAGE);
  process.exit(2);
}

const origin = baseUrl.replace(/\/$/, '');
const url = `${origin}/api/pbx/yeastar/events/${encodeURIComponent(token)}`;
const masked = `${token.slice(0, 4)}...${token.slice(-4)}`;
const sign = (body) =>
  createHmac('sha256', secret).update(body).digest('base64');
const pad = (n) => String(n).padStart(2, '0');
// Yeastar's time_start is read in the PBX's own zone; the sample uses UTC.
const now = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const { caller, extension } = values;
const run = randomUUID().slice(0, 8);
const callState = (callId, extStatus) => ({
  type: 30011,
  sn: 'SELFTEST',
  msg: {
    call_id: callId,
    members: [
      {
        inbound: {
          from: caller,
          to: extension,
          trunk_name: 'selftest-trunk',
          channel_id: `PJSIP/trunk-${run}-1`,
          member_status: 'ANSWER',
        },
      },
      {
        extension: {
          number: extension,
          channel_id: `PJSIP/${extension}-${run}`,
          member_status: extStatus,
        },
      },
    ],
  },
});
const callEnd = (callId, status, talk) => ({
  type: 30012,
  sn: 'SELFTEST',
  msg: {
    call_id: callId,
    time_start: now(),
    call_from: caller,
    call_to: extension,
    call_duration: talk + 10,
    talk_duration: talk,
    src_trunk_name: 'selftest-trunk',
    dst_trunk_name: '',
    pin_code: '',
    status,
    type: 'Inbound',
    recording: '',
    did_number: '',
    did_name: '',
    agent_ring_time: 10,
    uid: callId,
  },
});

const answered = `selftest-${run}-a`;
const missed = `selftest-${run}-m`;
const steps = [
  ['ringing', callState(answered, 'ALERT'), 200],
  ['answered', callState(answered, 'ANSWERED'), 200],
  ['call end (answered)', callEnd(answered, 'ANSWERED', 45), 200],
  ['missed call', callEnd(missed, 'NO ANSWER', 0), 200],
  ['bad signature refused', callState(answered, 'ALERT'), 401, 'bad'],
];

console.log(`Webhook ${origin}/api/pbx/yeastar/events/${masked}`);
let failed = 0;
for (const [name, payload, want, mode] of steps) {
  const body = JSON.stringify(payload);
  let line;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': mode === 'bad' ? sign(body + 'x') : sign(body),
      },
      body,
    });
    const ok = res.status === want;
    if (!ok) failed++;
    line = `${ok ? 'PASS' : 'FAIL'}  ${name}: HTTP ${res.status} (expected ${want})`;
    if (!ok && res.status === 404) line += ' - wrong base URL or token';
    if (!ok && res.status === 401)
      line += ' - secret does not match the connection';
    if (!ok && res.status === 503) line += ' - event not stored, retry later';
  } catch (err) {
    failed++;
    line = `FAIL  ${name}: ${err instanceof Error ? err.message : 'request failed'}`;
  }
  console.log(line);
}
console.log(failed ? `${failed} step(s) failed` : 'All steps passed');
console.log('Check Calls in the CRM for the caller number to see the records.');
process.exit(failed ? 1 : 0);
