import { describe, expect, it } from 'vitest';

import {
  NUMBERS_HEADER,
  PEOPLE_HEADER,
  isExportTable,
  numberRows,
  peopleRows,
  teamActivityCsv,
} from './export';
import { parseTeamActivityReport } from './report';

const PERIOD = {
  from: '2026-09-24T20:00:00.000Z',
  to: '2026-10-01T09:00:00.000Z',
  tz: 'Asia/Dubai',
};

const report = parseTeamActivityReport({
  tz: 'Asia/Dubai',
  senders: [
    {
      kind: 'person',
      user_id: 'u1',
      name: '=Agent One',
      email: 'one@example.com',
      role: 'agent',
      messages_sent: 40,
      chats_started: 12,
      mature_started: 10,
      mature_no_reply: 4,
      replies: 7,
      response_median_min: 4.5,
    },
    { kind: 'api', user_id: null, messages_sent: 5, chats_started: 5 },
    // Did nothing: a bot row is not listed then.
    { kind: 'bot', user_id: null },
    { kind: 'person', user_id: 'u2', name: 'Quiet Member' },
  ],
  numbers: [
    {
      channel_id: 'w1',
      provider: 'whapi',
      label: null,
      waba_id: '971500000001',
      phone_number_id: 'CHANNEL-1',
      status: 'connected',
      is_primary: true,
      chats_started: 17,
      mature_started: 10,
      mature_no_reply: 5,
    },
    {
      channel_id: 'm1',
      provider: 'meta',
      label: 'Sales',
      status: 'disconnected',
      is_primary: false,
    },
  ],
});

describe('isExportTable', () => {
  it('accepts the two tables only', () => {
    expect(isExportTable('people')).toBe(true);
    expect(isExportTable('numbers')).toBe(true);
    expect(isExportTable('daily')).toBe(false);
    expect(isExportTable(null)).toBe(false);
  });
});

describe('peopleRows', () => {
  const rows = peopleRows(report, PERIOD);

  it('lists every person and only active API or bot rows', () => {
    expect(rows.map((r) => r[3])).toEqual([
      '=Agent One',
      'API and integrations',
      'Quiet Member',
    ]);
  });

  it('matches the header width', () => {
    for (const r of rows) expect(r).toHaveLength(PEOPLE_HEADER.length);
  });

  it('carries the period, the figures and the mature reply rate', () => {
    const one = rows[0];
    const at = (h: string) => one[PEOPLE_HEADER.indexOf(h)];
    expect(one.slice(0, 3)).toEqual([PERIOD.from, PERIOD.to, PERIOD.tz]);
    expect(at('Messages sent')).toBe(40);
    expect(at('Chats started')).toBe(12);
    expect(at('Reply rate %')).toBe(60);
    expect(at('Replies to customers')).toBe(7);
    expect(at('Median response (minutes)')).toBe(4.5);
  });

  it('leaves replies and response time blank for the API row (D9)', () => {
    const api = rows[1];
    expect(api[PEOPLE_HEADER.indexOf('Replies to customers')]).toBeNull();
    expect(api[PEOPLE_HEADER.indexOf('Email')]).toBeNull();
    expect(api[PEOPLE_HEADER.indexOf('Median response (minutes)')]).toBeNull();
  });
});

describe('numberRows', () => {
  const rows = numberRows(report, PERIOD);

  it('names each number as the page does', () => {
    expect(rows.map((r) => r[3])).toEqual(['+971500000001', 'Sales']);
    for (const r of rows) expect(r).toHaveLength(NUMBERS_HEADER.length);
  });

  it('reads provider, type and figures', () => {
    const at = (r: unknown[], h: string) => r[NUMBERS_HEADER.indexOf(h)];
    expect(at(rows[0], 'Provider')).toBe('Whapi');
    expect(at(rows[0], 'Number type')).toBe('Phone');
    expect(at(rows[0], 'Primary')).toBe('Yes');
    expect(at(rows[0], 'Reply rate %')).toBe(50);
    expect(at(rows[1], 'Provider')).toBe('Meta Cloud API');
    expect(at(rows[1], 'Number type')).toBe('Official');
    expect(at(rows[1], 'Status')).toBe('disconnected');
  });
});

describe('teamActivityCsv', () => {
  it('writes a quoted CSV with the formula cell neutralised', () => {
    const csv = teamActivityCsv(report, 'people', PERIOD);
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0].startsWith('"Period start","Period end"')).toBe(true);
    expect(lines[1]).toContain(`"'=Agent One"`);
  });

  it('writes the numbers table', () => {
    const csv = teamActivityCsv(report, 'numbers', PERIOD);
    expect(csv).toContain('"Number","Provider"');
    expect(csv).toContain('"Sales"');
  });
});
