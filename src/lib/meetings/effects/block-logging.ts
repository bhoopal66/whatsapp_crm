// MediaPipe's vision bundle POSTs usage counters (OS family, SDK version,
// frame timings) to Google every minute through the global fetch, with no
// option to turn that off. Nothing of the call is in it, but it reveals the
// office's IP to a third party, and a staff CRM must not report out. The CSP is
// Report-Only, so it does not stop this. Answered 403, the library sets its
// own error flag and clears its interval, so it stops by itself.
const LOG_URL = 'https://odml.pa.googleapis.com/v1/log';

const wrapped = new WeakSet<object>();

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' || input instanceof URL ? String(input) : input.url;

export function blockMediaPipeLogging(
  target: Pick<typeof globalThis, 'fetch'> = globalThis
) {
  if (wrapped.has(target)) return;
  wrapped.add(target);
  const real = target.fetch;
  target.fetch = (input, init) =>
    urlOf(input).startsWith(LOG_URL)
      ? Promise.resolve(new Response(null, { status: 403 }))
      : real.call(target, input, init);
}
