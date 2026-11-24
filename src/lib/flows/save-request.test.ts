import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  afterSave,
  flowVersion,
  pressKeepMine,
  requestFlowSave,
  type FlowSaveMeta,
} from './save-request';

const meta: FlowSaveMeta = { dirty: true, expected: 'T1', conflict: null };
const conflict = { version: 'T2', at: 'T2', by: 'Sara' };

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('the version of a flow', () => {
  it('is the last save, or the creation of a flow never saved', () => {
    expect(flowVersion({ edited_at: 'E', created_at: 'C' })).toBe('E');
    expect(flowVersion({ edited_at: null, created_at: 'C' })).toBe('C');
    // Before 300 the column is absent.
    expect(flowVersion({ created_at: 'C' })).toBe('C');
  });
});

describe('requestFlowSave', () => {
  it('sends the expected version and reads each answer', async () => {
    const fetchMock = answer(200, { version: 'T2' });
    expect(await requestFlowSave('f1', { expected: 'T1' })).toEqual({
      kind: 'saved',
      version: 'T2',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect([url, init.method, JSON.parse(init.body as string)]).toEqual([
      '/api/flows/f1',
      'PUT',
      { expected: 'T1' },
    ]);
    answer(409, { changed: conflict });
    expect(await requestFlowSave('f1', {})).toEqual({
      kind: 'changed',
      ...conflict,
    });
    const issues = [{ severity: 'error', scope: 'flow', message: 'no' }];
    answer(422, { issues });
    expect(await requestFlowSave('f1', {})).toEqual({
      kind: 'invalid',
      issues,
    });
    answer(400, { error: 'bad' });
    expect(await requestFlowSave('f1', {})).toEqual({
      kind: 'failed',
      error: 'bad',
    });
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await requestFlowSave('f1', {})).toEqual({
      kind: 'failed',
      error: null,
    });
  });
});

describe('what a save does to the editor', () => {
  it('a save moves the version on and clears dirty', () => {
    const m = { ...meta, conflict };
    expect(afterSave(m, { kind: 'saved', version: 'T3' }, false)).toEqual({
      dirty: false,
      expected: 'T3',
      conflict: null,
    });
    // Before 300 there is no version: the one loaded still stands.
    expect(
      afterSave(meta, { kind: 'saved', version: null }, false).expected
    ).toBe('T1');
  });

  it('an edit made while saving is still unsaved', () => {
    expect(afterSave(meta, { kind: 'saved', version: 'T2' }, true).dirty).toBe(
      true
    );
  });

  it('a refused save leaves the edits unsaved and the version as it was', () => {
    expect(afterSave(meta, { kind: 'changed', ...conflict }, false)).toEqual({
      ...meta,
      conflict,
    });
    expect(
      afterSave({ ...meta, conflict }, { kind: 'invalid', issues: [] }, false)
    ).toEqual(meta);
    const failing = { ...meta, conflict };
    expect(afterSave(failing, { kind: 'failed', error: null }, false)).toEqual(
      failing
    );
  });

  it('Keep mine saves on the second press, over the version shown only', () => {
    expect(pressKeepMine(null, 'T2')).toEqual({ armedFor: 'T2', save: false });
    expect(pressKeepMine('T2', 'T2')).toEqual({ armedFor: null, save: true });
    expect(pressKeepMine('T2', 'T3')).toEqual({ armedFor: 'T3', save: false });
  });
});
