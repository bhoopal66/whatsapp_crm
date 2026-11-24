// ============================================================
// What a staff browser reports when a screen breaks. Pure: used by the
// browser (what is worth sending) and by the route (what is logged).
//
// A crash in someone's browser reached nobody: error.tsx printed it to
// that person's console and the server never heard. The report says which
// screen, what kind of error and where in the code, and NOTHING that could
// have been typed or received: an error's own words are kept only when
// they match a sentence the browser engine or React writes itself
// (`ENGINE_MESSAGES`). Everything else is withheld, because a message can
// quote anything ("… of Ahmed Ali, 971501234567"), and a stack begins with
// the message. The server applies the same rules to whatever it is sent.
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
  /** The error's class: TypeError, ChunkLoadError, … */
  name: string;
  /** The engine's own words, or null: withheld. */
  message: string | null;
  frames: string[];
  path: string;
  digest: string | null;
}

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

/**
 * Sentences an engine, React or the bundler writes: code words only, so
 * they can be logged whole. Anchored, and cut to the part that matched.
 */
const ENGINE_MESSAGES = [
  /^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)(?: \((?:reading|setting) '[\w$]{1,40}'\))?/,
  /^can't access property "[\w$]{1,40}", [\w$.]{1,60} is (?:undefined|null)/,
  /^(?:undefined|null) is not an object \(evaluating '[\w$.[\]()]{1,60}'\)/,
  /^[\w$.()]{1,60} is not (?:a function|defined|iterable|a constructor|an object)/,
  /^Cannot access '[\w$]{1,40}' before initialization/,
  /^Maximum call stack size exceeded/,
  /^Assignment to constant variable/,
  /^Invalid (?:array length|time value)/,
  /^Failed to execute '\w{1,40}' on '\w{1,40}'/,
  /^Loading (?:CSS )?chunk [\w-]{1,60} failed/,
  /^Minified React error #\d{1,4}/,
  /^Rendered (?:more|fewer) hooks than/,
  /^Hydration failed/,
];

/** The engine's own words of a message, or null. */
export function engineMessage(message: string): string | null {
  const text = message.trim();
  for (const re of ENGINE_MESSAGES) {
    const m = re.exec(text);
    if (m && !/\d{5,}/.test(m[0])) return m[0];
  }
  return null;
}

const errorName = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z]{1,40}$/.test(value) ? value : 'Error';

/** `name file.js:1:2`: a function's name and a place, nothing else. */
const FRAME = /^(?:[\w$.<>[\]]{1,60} )?[\w.~-]{1,80}(?::\d{1,9}){1,2}$/;

function frame(line: string): string | null {
  // `at f (https://host/_next/static/chunks/a.js:1:2)`, `f@https://…:1:2`.
  // Only a line that ends in an address with a position is a frame: a
  // stack begins with the message, whose lines can read like one.
  const m =
    /^\s*(?:at\s+)?(?:async\s+)?(?:new\s+)?([^\s@(]*)(?:\s\[as [\w$]+\])?[\s@(]*(?:https?:\/\/|webpack(?:-internal)?:)[^\s()]*?([^\s()/?#]+)(?:\?[^\s()]*?)?((?::\d{1,9}){1,2})\)?$/.exec(
      line
    );
  if (!m) return null;
  const name =
    /^[\w$.<>[\]]{1,60}$/.test(m[1]) && !/\d{5,}/.test(m[1]) ? m[1] : '';
  const out = `${name} ${m[2]}${m[3]}`.trim();
  return FRAME.test(out) ? out : null;
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
            /^(<id>|<x>|[a-z][\w-]{0,39})$/.test(part) && !/\d{5,}/.test(part)
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
  // A thrown text is somebody's words: only that it happened is told.
  const message = err ? err.message : typeof thrown === 'string' ? thrown : '';
  const name = err ? errorName(err.name) : 'ThrownText';
  const stack = err?.stack ?? '';
  if (
    !worthReporting(err ? `${err.name}: ${message || '-'}` : message, stack)
  ) {
    return null;
  }
  const digest = (err as { digest?: unknown } | null)?.digest;
  return {
    kind,
    name,
    message: err ? engineMessage(message) : null,
    frames: stackFrames(stack),
    path: maskPath(path),
    digest:
      typeof digest === 'string' && /^[\w@.-]{1,40}$/.test(digest)
        ? digest
        : null,
  };
}

/** What the server accepts of a posted body; null for anything else. */
export function parseReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const kind = CLIENT_ERROR_KINDS.find((k) => k === b.kind);
  if (!kind || typeof b.name !== 'string') return null;
  return {
    kind,
    name: errorName(b.name),
    message: typeof b.message === 'string' ? engineMessage(b.message) : null,
    frames: Array.isArray(b.frames)
      ? b.frames
          .filter((f): f is string => typeof f === 'string' && FRAME.test(f))
          .slice(0, FRAMES_MAX)
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
    ` ${report.name}: ${report.message ?? '(message withheld)'}` +
    (report.frames.length > 0 ? ` | ${report.frames.join(' < ')}` : '')
  );
}
