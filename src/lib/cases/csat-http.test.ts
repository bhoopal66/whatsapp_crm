import { describe, expect, it } from 'vitest';

import { CSAT_DEFAULTS } from './csat';
import {
  caseCsatItems,
  check,
  CsatRefused,
  csatErrorResponse,
  settingsArgs,
  settingsFromRow,
  sinceDays,
} from './csat-http';

const valid = {
  enabled: true,
  askOnSubmitted: true,
  askOnApproved: false,
  templateSubmitted: 'case_csat_submitted',
  templateApproved: 'case_csat_approved',
  language: 'ar',
  replyWindowDays: 7,
  sendStartHour: 9,
  sendEndHour: 20,
  expectedUpdatedAt: null,
};

describe('settingsFromRow', () => {
  it('gives the defaults for a workspace that never saved', () => {
    expect(settingsFromRow([])).toEqual({
      enabled: false,
      askOnSubmitted: true,
      askOnApproved: true,
      templateSubmitted: CSAT_DEFAULTS.templateSubmitted,
      templateApproved: CSAT_DEFAULTS.templateApproved,
      language: 'en',
      replyWindowDays: 7,
      sendStartHour: 9,
      sendEndHour: 20,
      updatedAt: null,
    });
  });
  it('reads a saved row', () => {
    expect(
      settingsFromRow([
        {
          enabled: true,
          ask_on_submitted: false,
          ask_on_approved: true,
          template_submitted: 'x',
          language: 'ar',
          reply_window_days: 3,
          send_start_hour: 10,
          send_end_hour: 18,
          updated_at: '2026-11-22T08:00:00.123456+00:00',
        },
      ])
    ).toMatchObject({
      enabled: true,
      askOnSubmitted: false,
      replyWindowDays: 3,
      updatedAt: '2026-11-22T08:00:00.123456+00:00',
    });
  });
});

describe('settingsArgs', () => {
  it('accepts a full body', () => {
    expect(settingsArgs(valid)).toEqual(valid);
  });
  it.each([
    ['no body', null],
    ['enabled missing', { ...valid, enabled: undefined }],
    ['bad template', { ...valid, templateSubmitted: 'Case CSAT' }],
    ['no approved template', { ...valid, templateApproved: '' }],
    ['bad language', { ...valid, language: 'english' }],
    ['window 0', { ...valid, replyWindowDays: 0 }],
    ['window 31', { ...valid, replyWindowDays: 31 }],
    ['start after end', { ...valid, sendStartHour: 20, sendEndHour: 20 }],
    ['end 22', { ...valid, sendEndHour: 22 }],
    ['bad version', { ...valid, expectedUpdatedAt: 'yesterday' }],
    ['version missing', { ...valid, expectedUpdatedAt: undefined }],
  ])('refuses %s', (_name, body) => {
    expect(() => settingsArgs(body)).toThrow(CsatRefused);
  });
});

describe('caseCsatItems', () => {
  it('words each request by what it waits on', () => {
    expect(
      caseCsatItems([
        {
          trigger: 'submitted',
          status: 'sent',
          score: 4,
          comment: 'ok',
          sent_at: 'a',
          responded_at: 'b',
        },
        { trigger: 'approved', status: 'sent', score: null, sent_at: 'a' },
        { trigger: 'approved', status: 'held' },
        { trigger: 'approved', status: 'skipped' },
        { trigger: 'other', status: 'sent' },
      ]).map((i) => [i.trigger, i.state, i.score])
    ).toEqual([
      ['submitted', 'rated', 4],
      ['approved', 'asked', null],
      ['approved', 'waiting', null],
      ['approved', 'not_sent', null],
    ]);
  });
});

describe('check and responses', () => {
  it('maps hints to refusals and hides other errors', async () => {
    expect(() => check('f', { hint: 'STALE', code: '40001' })).toThrow(
      CsatRefused
    );
    const stale = csatErrorResponse(new CsatRefused('STALE'), 'x');
    expect(stale.status).toBe(409);
    let other: unknown;
    try {
      check('case_csat_scores', { code: '42501', hint: null });
    } catch (e) {
      other = e;
    }
    const res = csatErrorResponse(other, 'x');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
  });
  it('reads the look-back in days', () => {
    expect(sinceDays(null)).toBe(90);
    expect(sinceDays('30')).toBe(30);
    expect(sinceDays('0')).toBe(90);
    expect(sinceDays('abc')).toBe(90);
    expect(sinceDays('400')).toBe(90);
  });
});
