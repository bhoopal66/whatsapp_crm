// ============================================================
// The page's half of a notification click (the worker's is
// public/sw.js): go there with the router, so drafts, staged files and a
// live recording survive, and answer, so the worker does not load the
// page instead. Pure.
// ============================================================

/** The last clicks gone to; a worker retries one for seconds only. */
const REMEMBERED = 20;

interface ClickMessage {
  data: unknown;
  ports: readonly Pick<MessagePort, 'postMessage'>[];
}

function safePath(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url[0] === '/' &&
    url[1] !== '/' &&
    url[1] !== '\\'
  );
}

/**
 * `push:navigate` is the message every version of the page follows,
 * `push:open` one that only a page that answers does. Each click is gone
 * to once, however often the worker repeats it.
 */
export function createPushNavigator(
  go: (url: string) => void
): (event: ClickMessage) => void {
  const seen: string[] = [];
  return ({ data, ports }) => {
    const msg = data as { type?: unknown; url?: unknown; id?: unknown } | null;
    if (msg?.type !== 'push:navigate' && msg?.type !== 'push:open') return;
    if (!safePath(msg.url)) return;
    const id = typeof msg.id === 'string' ? msg.id : null;
    ports[0]?.postMessage({ type: 'push:ack', id });
    if (id !== null) {
      if (seen.includes(id)) return;
      seen.push(id);
      if (seen.length > REMEMBERED) seen.shift();
    }
    go(msg.url);
  };
}
