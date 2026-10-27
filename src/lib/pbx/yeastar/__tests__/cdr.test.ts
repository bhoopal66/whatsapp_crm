import { describe, expect, it } from 'vitest';
import { cdrRecordToCallEnd, dedupeRecords } from '../cdr';
import { parseYeastarEvent } from '../events';
import { CDR_SEARCH_OK } from './fixtures';

const omit = (o: object, ...keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const [internal, , legacy] = CDR_SEARCH_OK.data;

describe('cdrRecordToCallEnd', () => {
  it('maps a v1 cdr/search row (doc example) to the call-end shape', () => {
    expect(cdrRecordToCallEnd(internal)).toEqual({
      ok: true,
      event: {
        kind: 'call_end',
        type: 30012,
        callId: '1766112007.0',
        uid: '2025121910400711733',
        direction: 'internal',
        from: '1001',
        to: '6901',
        startedAt: '2025-12-19T02:40:07.000Z',
        startedAtRaw: 1766112007,
        callSeconds: 10,
        talkSeconds: 10,
        status: 'ANSWERED',
        raw: internal,
      },
    });
  });

  it('legacy row: outbound, DID, number pulled out of "Name<number>"', () => {
    const bare = omit(legacy, 'call_from_number', 'call_to_number');
    const r = cdrRecordToCallEnd({
      ...bare,
      record_file: '20220530145341-2005-1000-Outbound.wav',
    });
    expect(r).toMatchObject({
      ok: true,
      event: {
        direction: 'outbound',
        from: '2005',
        to: '1000',
        didNumber: '123456',
        recordingFile: '20220530145341-2005-1000-Outbound.wav',
      },
    });
  });

  it('without `timestamp`, reads the display time in the PBX zone', () => {
    const noTs = omit(internal, 'timestamp');
    expect(
      cdrRecordToCallEnd(noTs, { pbxTimeZone: 'Asia/Shanghai' })
    ).toMatchObject({
      ok: true,
      event: {
        startedAt: '2025-12-19T02:40:07.000Z',
        startedAtRaw: '2025/12/19 10:40:07',
      },
    });
  });

  it('stores the same row as the live 30012 event for the same call', () => {
    const live = parseYeastarEvent({
      type: 30012,
      msg: {
        call_id: '1766112007.0',
        uid: '2025121910400711733',
        type: 'Internal',
        call_from: '1001',
        call_to: '6901',
        time_start: '2025-12-19 06:40:07',
        call_duration: 10,
        talk_duration: 10,
        status: 'ANSWERED',
        recording: '',
        did_number: '',
        did_name: '',
      },
    });
    const backfill = cdrRecordToCallEnd(internal);
    expect(live.ok && backfill.ok).toBe(true);
    if (!live.ok || !backfill.ok) return;
    const row = (e: object) => omit(e, 'raw', 'startedAtRaw');
    expect(row(live.event)).toEqual(row(backfill.event));
  });

  it('a row without a uid cannot be stored', () => {
    expect(cdrRecordToCallEnd({ ...internal, uid: '' })).toMatchObject({
      ok: false,
    });
    expect(cdrRecordToCallEnd({})).toMatchObject({ ok: false });
  });
});

describe('dedupeRecords', () => {
  it('drops an identical repeat (overlapping pages), in order', () => {
    const rows = [
      ...CDR_SEARCH_OK.data,
      { ...CDR_SEARCH_OK.data[0] },
      { uid: '' },
      { uid: '' },
    ];
    expect(dedupeRecords(rows)).toEqual([...CDR_SEARCH_OK.data, { uid: '' }]);
  });

  it('a key order of its own is still the same record', () => {
    const reordered = Object.fromEntries(
      Object.entries(internal).reverse()
    ) as typeof internal;
    expect(dedupeRecords([internal, reordered])).toEqual([internal]);
  });

  it('keeps same-uid rows that differ: they are legs of one call (live)', () => {
    const noAnswer = {
      ...internal,
      disposition: 'NO ANSWER',
      talk_duration: 0,
    };
    const voicemail = {
      ...internal,
      disposition: 'VOICEMAIL',
      timestamp: Number(internal.timestamp) + 24,
    };
    expect(dedupeRecords([noAnswer, voicemail, noAnswer])).toEqual([
      noAnswer,
      voicemail,
    ]);
  });
});
