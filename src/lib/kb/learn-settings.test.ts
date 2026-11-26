import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  KB_LEARN_RUN_ERRORS,
  KB_LEARN_RUN_STALE_MS,
  KB_LEARN_SETTINGS_OFF,
  KB_LEARN_SWITCH_LOADING,
  isLearnedEntry,
  kbLearnSettingsFrom,
  kbLearnSwitchReduce,
  kbLearnSwitchView,
  type KbLearnSettings,
  type KbLearnSwitchEvent,
  type KbLearnSwitchState,
  parseKbLearnPut,
  parseKbLearnResponse,
} from './learn-settings';

describe('kbLearnSettingsFrom', () => {
  it('reads no row as off', () => {
    expect(kbLearnSettingsFrom(null)).toEqual(KB_LEARN_SETTINGS_OFF);
    expect(KB_LEARN_SETTINGS_OFF.enabled).toBe(false);
  });
  it('reads a row, and a bad count as unknown', () => {
    expect(
      kbLearnSettingsFrom({
        enabled: true,
        last_run_at: '2026-11-20T08:00:00Z',
        last_run_drafted: 3,
      })
    ).toEqual({
      enabled: true,
      lastRunAt: '2026-11-20T08:00:00Z',
      lastRunDrafted: 3,
      lastRunError: null,
      nextRunAt: null,
      available: true,
    });
    expect(
      kbLearnSettingsFrom({ enabled: 'yes', last_run_drafted: -1 })
    ).toMatchObject({ enabled: false, lastRunDrafted: null });
  });
  it('reads the run error; one it does not know is still a failure', () => {
    const read = (last_run_error: unknown) =>
      kbLearnSettingsFrom({ last_run_error }).lastRunError;
    for (const code of ['running', ...KB_LEARN_RUN_ERRORS])
      expect(read(code)).toBe(code);
    expect(read('new_code')).toBe('failed');
    expect(read(null)).toBeNull();
  });
  it('has the codes 290 allows', () => {
    const sql = readFileSync(
      new URL('../../../supabase/migrations/290_kb_learn.sql', import.meta.url),
      'utf8'
    );
    const list = /CHECK \(last_run_error IN \(([^)]+)\)\)/.exec(sql)![1]!;
    expect(list.match(/\w+/g)).toEqual(['running', ...KB_LEARN_RUN_ERRORS]);
  });
});

describe('parseKbLearnResponse', () => {
  it('reads the route’s answer', () => {
    expect(
      parseKbLearnResponse({
        enabled: true,
        lastRunAt: '2026-11-20T08:00:00Z',
        lastRunDrafted: 0,
        lastRunError: 'model',
        nextRunAt: '2026-11-20T09:00:00Z',
        available: true,
      })
    ).toEqual({
      enabled: true,
      lastRunAt: '2026-11-20T08:00:00Z',
      lastRunDrafted: 0,
      lastRunError: 'model',
      nextRunAt: '2026-11-20T09:00:00Z',
      available: true,
    });
  });
  it('is null for junk (never "off"), and keeps "not applied"', () => {
    for (const junk of ['nope', null, {}, { enabled: 'yes' }])
      expect(parseKbLearnResponse(junk)).toBeNull();
    expect(
      parseKbLearnResponse({ enabled: false, available: false })?.available
    ).toBe(false);
  });
});

describe('parseKbLearnPut', () => {
  it('takes a boolean only', () => {
    expect(parseKbLearnPut({ enabled: true })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(parseKbLearnPut({ enabled: 1 }).ok).toBe(false);
    expect(parseKbLearnPut([]).ok).toBe(false);
  });
});

describe('isLearnedEntry', () => {
  it('is the learned source only', () => {
    expect(isLearnedEntry({ source: 'learned' })).toBe(true);
    expect(isLearnedEntry({ source: 'knowledge_gap' })).toBe(false);
    expect(isLearnedEntry({ source: null })).toBe(false);
  });
});

const NOW = Date.parse('2026-11-24T10:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const ready = (over: Partial<KbLearnSettings> = {}): KbLearnSwitchState => ({
  settings: { ...KB_LEARN_SETTINGS_OFF, enabled: true, ...over },
  loadFailed: false,
  saving: null,
});
const reduce = (state: KbLearnSwitchState, ...events: KbLearnSwitchEvent[]) =>
  events.reduce(kbLearnSwitchReduce, state);

describe('the switch after a failed load', () => {
  const FAILED: [string, KbLearnSwitchEvent][] = [
    ['a server error', { type: 'loaded', ok: false, json: { error: 'x' } }],
    [
      'an error that looks like a setting',
      {
        type: 'loaded',
        ok: false,
        json: { enabled: false },
      },
    ],
    ['no settings in the answer', { type: 'loaded', ok: true, json: {} }],
    ['no answer', { type: 'loaded', ok: false, json: null }],
  ];
  it.each(FAILED)('%s: "Could not load", nothing to save', (_n, event) => {
    const state = reduce(KB_LEARN_SWITCH_LOADING, event);
    expect(kbLearnSwitchView(state, NOW)).toEqual({ kind: 'failed' });
    // A save is not taken over it.
    expect(reduce(state, { type: 'save', enabled: true })).toBe(state);
  });
  it('Retry loads again', () => {
    const state = reduce(
      KB_LEARN_SWITCH_LOADING,
      { type: 'loaded', ok: false, json: null },
      { type: 'load' }
    );
    expect(kbLearnSwitchView(state, NOW)).toEqual({ kind: 'loading' });
    expect(
      kbLearnSwitchView(
        reduce(state, { type: 'loaded', ok: true, json: { enabled: true } }),
        NOW
      )
    ).toMatchObject({ kind: 'switch', checked: true, disabled: false });
  });
  it('a failed reload does not keep the old answer', () => {
    const state = reduce(ready(), { type: 'loaded', ok: false, json: null });
    expect(kbLearnSwitchView(state, NOW)).toEqual({ kind: 'failed' });
  });
});

describe('the switch while saving', () => {
  it('moves at once, and back when the save fails', () => {
    const saving = reduce(ready(), { type: 'save', enabled: false });
    expect(kbLearnSwitchView(saving, NOW)).toMatchObject({
      checked: false,
      disabled: true,
    });
    const back = reduce(saving, { type: 'saved', ok: false, json: null });
    expect(kbLearnSwitchView(back, NOW)).toMatchObject({
      checked: true,
      disabled: false,
    });
  });
  it('shows what the server stored', () => {
    const save: KbLearnSwitchEvent = { type: 'save', enabled: true };
    const off = ready({ enabled: false, lastRunError: 'no_ai' });
    expect(
      reduce(off, save, { type: 'saved', ok: true, json: { enabled: true } })
    ).toEqual(ready());
    // Saved, but the answer cannot be read: what was asked for.
    expect(
      reduce(off, save, { type: 'saved', ok: true, json: null }).settings
    ).toMatchObject({ enabled: true });
  });
  it('cannot be set before 290, nor while loading', () => {
    for (const state of [ready({ available: false }), KB_LEARN_SWITCH_LOADING])
      expect(reduce(state, { type: 'save', enabled: true })).toBe(state);
  });
});

describe('the line under the switch', () => {
  const line = (over: Partial<KbLearnSettings>) => {
    const view = kbLearnSwitchView(ready(over), NOW);
    return view.kind === 'switch' ? view.line : undefined;
  };
  it.each([
    ['no_ai', 'failedNoAi'],
    ['read_failed', 'failedRead'],
    ['out_of_time', 'failedTime'],
    ['model', 'failedModel'],
    ['failed', 'failedOther'],
  ] as const)('%s is said in words, with the next try', (code, key) => {
    const failed = { lastRunError: code, lastRunAt: at(-5), lastRunDrafted: 0 };
    expect(line({ ...failed, nextRunAt: at(45) })).toEqual({
      key,
      retryAt: at(45),
    });
    // Over already: the next hourly check.
    expect(line({ ...failed, nextRunAt: at(-1) })).toEqual({
      key,
      retryAt: null,
    });
  });
  it('a run in progress, and one that died', () => {
    const running = { lastRunError: 'running', nextRunAt: at(45) } as const;
    expect(line({ ...running, lastRunAt: at(-1) })).toEqual({
      key: 'runningNow',
    });
    expect(
      line({
        ...running,
        lastRunAt: new Date(NOW - KB_LEARN_RUN_STALE_MS - 1).toISOString(),
      })
    ).toEqual({ key: 'failedStopped', retryAt: at(45) });
  });
  it('a finished run, none yet, off and not applied', () => {
    expect(line({ lastRunAt: at(-60), lastRunDrafted: 3 })).toEqual({
      key: 'lastRunDrafts',
      at: at(-60),
      count: 3,
    });
    expect(line({ lastRunAt: at(-60) })).toEqual({
      key: 'lastRun',
      at: at(-60),
    });
    expect(line({})).toEqual({ key: 'notRunYet' });
    expect(line({ enabled: false, lastRunError: 'model' })).toBeNull();
    expect(line({ available: false })).toEqual({ key: 'notApplied' });
  });
});
