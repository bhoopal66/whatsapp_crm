/**
 * A small Prometheus registry for GET /api/metrics (package 033f): counters
 * and gauges rendered in the text exposition format 0.0.4, with no
 * dependency (prom-client would add default collectors we do not want).
 *
 * - Label values are escaped (backslash, double quote, newline).
 * - Each family keeps at most MAX_LABEL_SETS label sets; later ones fold
 *   into one series whose labels are all "overflow", so a bad label can
 *   never grow the page without bound.
 * - Counters live for the process (Prometheus' rate() copes with resets).
 *   The registry is a globalThis singleton: Next.js may bundle this module
 *   into several route chunks, and they must all count into one place.
 *
 * Pure: no I/O. Server-only by use, but safe anywhere.
 */

export const MAX_LABEL_SETS = 500;

type Labels = Record<string, string>;

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((n) => labels[n] ?? '').join('\u0000');
}

function renderLabels(names: readonly string[], values: string[]): string {
  if (names.length === 0) return '';
  return `{${names.map((n, i) => `${n}="${escapeValue(values[i])}"`).join(',')}}`;
}

function formatNumber(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

abstract class Family {
  protected readonly series = new Map<
    string,
    { values: string[]; v: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[]
  ) {}

  protected slot(labels: Labels): { values: string[]; v: number } {
    let key = labelKey(this.labelNames, labels);
    let values = this.labelNames.map((n) => labels[n] ?? '');
    if (!this.series.has(key) && this.series.size >= MAX_LABEL_SETS) {
      values = this.labelNames.map(() => 'overflow');
      key = labelKey(
        this.labelNames,
        Object.fromEntries(this.labelNames.map((n) => [n, 'overflow']))
      );
    }
    let s = this.series.get(key);
    if (!s) {
      s = { values, v: 0 };
      this.series.set(key, s);
    }
    return s;
  }

  abstract readonly type: 'counter' | 'gauge';

  render(): string {
    const lines = [
      `# HELP ${this.name} ${escapeHelp(this.help)}`,
      `# TYPE ${this.name} ${this.type}`,
    ];
    for (const s of this.series.values()) {
      lines.push(
        `${this.name}${renderLabels(this.labelNames, s.values)} ${formatNumber(s.v)}`
      );
    }
    return lines.join('\n');
  }

  /** Test helper: the current value of one label set (0 when absent). */
  value(labels: Labels = {}): number {
    return this.series.get(labelKey(this.labelNames, labels))?.v ?? 0;
  }

  size(): number {
    return this.series.size;
  }
}

export class Counter extends Family {
  readonly type = 'counter' as const;
  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) return;
    this.slot(labels).v += by;
  }
}

export class Gauge extends Family {
  readonly type = 'gauge' as const;
  set(labels: Labels, v: number): void {
    this.slot(labels).v = v;
  }
  /** Gauges read at scrape time are rebuilt each scrape. */
  reset(): void {
    this.series.clear();
  }
}

export class Registry {
  private readonly families = new Map<string, Family>();

  counter(
    name: string,
    help: string,
    labelNames: readonly string[] = []
  ): Counter {
    return this.get(name, () => new Counter(name, help, labelNames)) as Counter;
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.get(name, () => new Gauge(name, help, labelNames)) as Gauge;
  }

  private get(name: string, make: () => Family): Family {
    let f = this.families.get(name);
    if (!f) {
      f = make();
      this.families.set(name, f);
    }
    return f;
  }

  /** The whole page, families in registration order, ending in a newline. */
  render(): string {
    return [...this.families.values()].map((f) => f.render()).join('\n') + '\n';
  }
}

const GLOBAL_KEY = '__wacrmMetricsRegistry';

/** The process-wide registry the counters and the /api/metrics route share. */
export function metricsRegistry(): Registry {
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  g[GLOBAL_KEY] ??= new Registry();
  return g[GLOBAL_KEY];
}

/**
 * Requests edge security turned away (lib/edge, lib/api/v1). Counting
 * never changes what the caller is answered.
 */
export type EdgeRefusal =
  | 'webhook_ip_limited'
  | 'webhook_sender_limited'
  | 'webhook_duplicate'
  | 'signin_locked'
  | 'signin_rate_limited'
  | 'api_rate_limited'
  | 'webform_rate_limited'
  | 'webform_origin_refused'
  | 'webform_too_large'
  | 'webform_honeypot'
  | 'webform_not_found';

export function edgeRefusals(): Counter {
  return metricsRegistry().counter(
    'wacrm_edge_refusals_total',
    'Requests or events turned away by edge security, by kind.',
    ['kind']
  );
}

/** Never throws: a metrics fault must not change an edge decision. */
export function countEdgeRefusal(kind: EdgeRefusal, by = 1): void {
  try {
    edgeRefusals().inc({ kind }, by);
  } catch {
    /* counting is best-effort */
  }
}
