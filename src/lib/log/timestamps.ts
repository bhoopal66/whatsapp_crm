/**
 * Puts the time and the level in front of every server log line. The
 * service appends stdout to a plain file (docs/monitoring.md), so
 * without this a line says what happened but not when.
 */
const LEVELS = {
  debug: 'DEBUG',
  log: 'INFO',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
} as const;

type Level = keyof typeof LEVELS;
export type LogTarget = Record<Level, (...args: unknown[]) => void>;

const INSTALLED = Symbol.for('wacrm.logTimestamps');

/** The arguments with the prefix: kept in the format string when there is one. */
export function stamped(level: Level, at: Date, args: unknown[]): unknown[] {
  const prefix = `${at.toISOString()} ${LEVELS[level]}`;
  return typeof args[0] === 'string'
    ? [`${prefix} ${args[0]}`, ...args.slice(1)]
    : [prefix, ...args];
}

/** Wraps the console once per process; a second call changes nothing. */
export function installLogTimestamps(
  target: LogTarget = console as unknown as LogTarget,
  now: () => Date = () => new Date()
): void {
  const marked = target as LogTarget & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  for (const level of Object.keys(LEVELS) as Level[]) {
    const original = target[level].bind(target);
    target[level] = (...args) => original(...stamped(level, now(), args));
  }
}
