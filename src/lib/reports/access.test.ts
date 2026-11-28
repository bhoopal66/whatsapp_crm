import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REPORT_KEYS,
  isReportKey,
  parseReportAccessList,
  parseReportAccessPeople,
  parseReportKeys,
  reportsFor,
} from './access';

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/255_chat_tag_report.sql'),
  'utf8'
);

describe('REPORT_KEYS', () => {
  it("equals 255's report_access_report_key_check", () => {
    const m = MIGRATION.match(
      /report_access_report_key_check\s+CHECK \(report_key IN \(([^)]*)\)\)/
    );
    expect(m).not.toBeNull();
    const keys = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...REPORT_KEYS].sort()).toEqual(keys.sort());
  });

  it('knows only those keys', () => {
    expect(isReportKey('chat_tags')).toBe(true);
    expect(isReportKey('funnel')).toBe(false);
    expect(isReportKey(null)).toBe(false);
  });
});

describe('parseReportKeys', () => {
  it('keeps known keys once', () => {
    expect(parseReportKeys(['chat_tags', 'chat_tags', 'other'])).toEqual([
      'chat_tags',
    ]);
  });

  it('answers nothing for a non-array', () => {
    expect(parseReportKeys(null)).toEqual([]);
    expect(parseReportKeys('chat_tags')).toEqual([]);
  });
});

describe('parseReportAccessList', () => {
  it('reads rows and drops ones with no user id', () => {
    expect(
      parseReportAccessList([
        {
          user_id: 'u1',
          name: 'Sara',
          role: 'agent',
          granted: true,
          granted_at: '2026-11-20T10:00:00Z',
        },
        { user_id: 'u2', name: null, role: 'viewer', granted: 'yes' },
        { name: 'no id' },
        null,
      ])
    ).toEqual([
      {
        userId: 'u1',
        name: 'Sara',
        role: 'agent',
        granted: true,
        grantedAt: '2026-11-20T10:00:00Z',
      },
      {
        userId: 'u2',
        name: '',
        role: 'viewer',
        granted: false,
        grantedAt: null,
      },
    ]);
  });

  it('answers nothing for a non-array', () => {
    expect(parseReportAccessList({})).toEqual([]);
  });
});

describe('parseReportAccessPeople', () => {
  const sql = [
    {
      user_id: 'u1',
      name: 'Demo Admin',
      role: 'admin',
      granted: true,
      granted_at: '2026-11-22T10:00:00Z',
    },
    { user_id: 'u2', name: 'Demo Agent', role: 'agent', granted: false },
  ];

  it('reads what the access route sends, round trip through its parser', () => {
    // The route answers { people: parseReportAccessList(data) } as JSON;
    // the card must read that back without losing a row.
    const wire = JSON.parse(JSON.stringify(parseReportAccessList(sql)));
    expect(parseReportAccessPeople(wire)).toEqual([
      {
        userId: 'u1',
        name: 'Demo Admin',
        role: 'admin',
        granted: true,
        grantedAt: '2026-11-22T10:00:00Z',
      },
      {
        userId: 'u2',
        name: 'Demo Agent',
        role: 'agent',
        granted: false,
        grantedAt: null,
      },
    ]);
  });

  it('drops junk rows', () => {
    expect(parseReportAccessPeople([null, 3, { userId: '' }])).toEqual([]);
    expect(parseReportAccessPeople('x')).toEqual([]);
  });
});

describe('reportsFor', () => {
  const keysOf = (role: Parameters<typeof reportsFor>[0], keys: string[]) =>
    reportsFor(role, keys).map((e) => e.key);

  it('gives the owner both reports', () => {
    expect(keysOf('owner', ['chat_tags'])).toEqual(['funnel', 'chat_tags']);
    // The owner opens the tag report even if the key list failed.
    expect(keysOf('owner', [])).toEqual(['funnel', 'chat_tags']);
  });

  it('gives an admin the funnel, and the tag report only with a grant', () => {
    expect(keysOf('admin', [])).toEqual(['funnel']);
    expect(keysOf('admin', ['chat_tags'])).toEqual(['funnel', 'chat_tags']);
  });

  it('gives staff below admin only what they were granted', () => {
    expect(keysOf('agent', [])).toEqual([]);
    expect(keysOf('viewer', ['chat_tags'])).toEqual(['chat_tags']);
    expect(keysOf('team_leader', ['chat_tags'])).toEqual(['chat_tags']);
  });

  it('gives a bank guest nothing', () => {
    expect(keysOf('bank_guest', ['chat_tags'])).toEqual([]);
  });

  it('links each entry to its page', () => {
    expect(reportsFor('owner', []).map((e) => e.href)).toEqual([
      '/reports/funnel',
      '/reports/tags',
    ]);
  });
});
