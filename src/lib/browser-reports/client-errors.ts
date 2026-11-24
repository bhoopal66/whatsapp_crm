// ============================================================
// What a staff browser reports when a screen breaks. Pure: used by the
// browser (what is worth sending) and by the route (what is logged).
//
// A crash in someone's browser reached nobody: error.tsx printed it to
// that person's console and the server never heard. The report carries
// the message, the stack's frames and the path, and nothing typed on the
// screen; the server masks it again, because a message can quote data
// ("… of contact 971501234567").
// ============================================================

export const CLIENT_ERROR_KINDS = [
  'boundary',
  'global',
  'error',
  'rejection',
] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  frames: string[];
  path: string;
  digest: string | null;
}

const MESSAGE_MAX = 300;
const FRAME_MAX = 160;
const FRAMES_MAX = 8;
const PATH_MAX = 160;

/** Not ours to fix: the network, the browser's own limits, extensions. */
const NOISE = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /AbortError|The user aborted a request|signal is aborted/i,
  /Failed to fetch|NetworkError when attempting|Load failed|network error/i,
  /Extension context invalidated/i,
  /play\(\) (request|failed)|NotAllowedError/i,
];
const FOREIGN = /(chrome|moz|safari-web|safari)-extension:\/\//i;

/** Whether an error is worth telling the server about. */
export function worthReporting(message: string, stack: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (FOREIGN.test(stack) || FOREIGN.test(text)) return false;
  return !NOISE.some((re) => re.test(text));
}

/** Ids, numbers, emails and long quotes out of a line of text. */
export function maskText(text: string): string {
  return text
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<id>'
    )
    .replace(/[^\s@"'<>()[\],;]+@[^\s@"'<>()[\],;]+\.[a-z]{2,}/gi, '<email>')
    .replace(/"[^"]{25,}"/g, '"<text>"')
    .replace(/'[^']{25,}'/g, "'<text>'")
    .replace(/[\d٠-٩۰-۹][\d٠-٩۰-۹ ()+-]{3,}[\d٠-٩۰-۹]/g, '<n>');
}

/** `at f (https://host/_next/static/chunks/a.js:1:2)` → `f a.js:1:2`. */
function frame(line: string): string | null {
  const text = line.trim();
  if (!/^at\s|@/.test(text)) return null;
  const m =
    /^(?:at\s+)?(.*?)[\s@(]*((?:https?:\/\/|webpack|blob:|<anonymous>)[^\s)]*)\)?$/.exec(
      text
    );
  const where = m ? m[2] : text;
  const file = where.replace(/[?#].*?(?=:\d+(:\d+)?$|$)/, '');
  const short = file.split('/').slice(-1)[0] ?? file;
  const name = m ? m[1].replace(/^async(\s+|$)/, '').trim() : '';
  return maskFrame(`${name} ${short}`.trim()).slice(0, FRAME_MAX);
}

/** Line and column numbers stay; an id inside a name does not. */
function maskFrame(text: string): string {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<id>'
  );
}

export function stackFrames(stack: string): string[] {
  const out: string[] = [];
  for (const line of stack.split('\n')) {
    const f = frame(line);
    if (f) out.push(f);
    if (out.length === FRAMES_MAX) break;
  }
  return out;
}

/** A path with its ids taken out, and no query: both can name a customer. */
export function maskPath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? '';
  return (
    '/' +
    clean
      .split('/')
      .filter(Boolean)
      .map((part) =>
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(part)
          ? '<id>'
          : // `<id>` and `<x>`: masked by the browser already.
            /^(<id>|<x>|[\w.-]{1,40})$/.test(part) && !/\d{5,}/.test(part)
            ? part
            : '<x>'
      )
      .join('/')
  ).slice(0, PATH_MAX);
}

/** The report a browser sends, from anything thrown. */
export function buildReport(
  kind: ClientErrorKind,
  thrown: unknown,
  path: string
): ClientErrorReport | null {
  const err = thrown instanceof Error ? thrown : null;
  const message = err
    ? `${err.name}: ${err.message}`
    : typeof thrown === 'string'
      ? thrown
      : '';
  const stack = err?.stack ?? '';
  if (!worthReporting(message, stack)) return null;
  const digest = (err as { digest?: unknown } | null)?.digest;
  return {
    kind,
    message: maskText(message).slice(0, MESSAGE_MAX),
    frames: stackFrames(stack),
    path: maskPath(path),
    digest: typeof digest === 'string' ? digest.slice(0, 40) : null,
  };
}

/** What the server accepts of a posted body; null for anything else. */
export function parseReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const kind = CLIENT_ERROR_KINDS.find((k) => k === b.kind);
  if (!kind || typeof b.message !== 'string') return null;
  const message = b.message.replace(/[\u0000-\u001f]+/g, ' ').trim();
  if (!message) return null;
  return {
    kind,
    message: maskText(message).slice(0, MESSAGE_MAX),
    frames: Array.isArray(b.frames)
      ? b.frames
          .filter((f): f is string => typeof f === 'string')
          .slice(0, FRAMES_MAX)
          .map((f) =>
            maskFrame(f.replace(/[\u0000-\u001f]+/g, ' ')).slice(0, FRAME_MAX)
          )
      : [],
    path: typeof b.path === 'string' ? maskPath(b.path) : '/',
    digest:
      typeof b.digest === 'string' && /^[\w@.-]{1,40}$/.test(b.digest)
        ? b.digest
        : null,
  };
}

/** One log line. */
export function reportLine(report: ClientErrorReport, who: string): string {
  return (
    `[client-error] ${report.kind} ${report.path} user=${who}` +
    (report.digest ? ` digest=${report.digest}` : '') +
    ` ${report.message}` +
    (report.frames.length > 0 ? ` | ${report.frames.join(' < ')}` : '')
  );
}
