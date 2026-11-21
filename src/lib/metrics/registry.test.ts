import { describe, expect, it } from 'vitest';
import {
  MAX_LABEL_SETS,
  Registry,
  countEdgeRefusal,
  edgeRefusals,
  metricsRegistry,
} from './registry';

describe('Registry', () => {
  it('renders HELP and TYPE lines, then one line per label set', () => {
    const r = new Registry();
    r.counter('jobs_total', 'Jobs done.', ['kind']).inc({ kind: 'a' }, 2);
    r.gauge('temp', 'A gauge.').set({}, 1.5);
    expect(r.render()).toBe(
      [
        '# HELP jobs_total Jobs done.',
        '# TYPE jobs_total counter',
        'jobs_total{kind="a"} 2',
        '# HELP temp A gauge.',
        '# TYPE temp gauge',
        'temp 1.5',
        '',
      ].join('\n')
    );
  });

  it('escapes label values and help text', () => {
    const r = new Registry();
    r.gauge('g', 'line one\nline two \\ end', ['l']).set({ l: 'a"b\\c\nd' }, 1);
    const out = r.render();
    expect(out).toContain('# HELP g line one\\nline two \\\\ end');
    expect(out).toContain('g{l="a\\"b\\\\c\\nd"} 1');
  });

  it('folds label sets past the cap into one overflow series', () => {
    const r = new Registry();
    const c = r.counter('c_total', 'x', ['id']);
    for (let i = 0; i < MAX_LABEL_SETS + 5; i++) c.inc({ id: String(i) });
    expect(c.size()).toBe(MAX_LABEL_SETS + 1);
    expect(c.value({ id: 'overflow' })).toBe(5);
    expect(r.render()).toContain('c_total{id="overflow"} 5');
  });

  it('a counter never goes down; a gauge resets for the next scrape', () => {
    const r = new Registry();
    const c = r.counter('c_total', 'x');
    c.inc({}, 3);
    c.inc({}, -1);
    c.inc({}, Number.NaN);
    expect(c.value()).toBe(3);
    const g = r.gauge('g', 'x', ['k']);
    g.set({ k: 'a' }, 1);
    g.reset();
    expect(g.size()).toBe(0);
  });

  it('returns the same family for the same name', () => {
    const r = new Registry();
    expect(r.counter('a_total', 'x')).toBe(r.counter('a_total', 'x'));
  });
});

describe('the process-wide registry and edge refusals', () => {
  it('is one registry however many times it is asked for', () => {
    expect(metricsRegistry()).toBe(metricsRegistry());
  });

  it('counts edge refusals by kind', () => {
    const before = edgeRefusals().value({ kind: 'signin_locked' });
    countEdgeRefusal('signin_locked');
    countEdgeRefusal('signin_locked', 2);
    expect(edgeRefusals().value({ kind: 'signin_locked' }) - before).toBe(3);
    expect(metricsRegistry().render()).toContain(
      'wacrm_edge_refusals_total{kind="signin_locked"}'
    );
  });
});
