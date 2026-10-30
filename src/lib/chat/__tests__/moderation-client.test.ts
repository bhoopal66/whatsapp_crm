import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import * as api from '../api';
import { exportFileName, exportToCsv } from '../export';
import { toChannel, toChannelMember, toChatMessage } from '../types';

type Result = { data: unknown; error: unknown };

function fakeSb(result: Result = { data: null, error: null }) {
  const rpcs: { fn: string; args: unknown }[] = [];
  const chain: { op: string; args: unknown[] }[] = [];
  const sb = {
    rpc: (fn: string, args?: unknown) => {
      rpcs.push({ fn, args });
      return Promise.resolve(result);
    },
    from: (table: string) => {
      chain.push({ op: 'from', args: [table] });
      const b: Record<string, unknown> = {
        then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej),
      };
      for (const op of ['select', 'eq'])
        b[op] = (...args: unknown[]) => (chain.push({ op, args }), b);
      return b;
    },
  };
  return { sb: sb as unknown as SupabaseClient, rpcs, chain };
}

const CH = 'cccccccc-0000-4000-8000-000000000001';
const US = 'uuuuuuuu-0000-4000-8000-000000000002';
const MSG = 'eeeeeeee-0000-4000-8000-00000000000e';

describe('159/160 mappers', () => {
  it('maps the new columns and defaults them to null', () => {
    expect(
      toChannel({ id: CH, audience_min_role: 'agent' }).audienceMinRole
    ).toBe('agent');
    expect(toChannel({ id: CH }).audienceMinRole).toBeNull();
    expect(
      toChannelMember({
        channel_id: CH,
        post_blocked_until: '2026-11-01T00:00:00Z',
      }).postBlockedUntil
    ).toBe('2026-11-01T00:00:00Z');
    expect(toChannelMember({ channel_id: CH }).postBlockedUntil).toBeNull();
    expect(toChatMessage({ id: MSG, deleted_by: US }).deletedBy).toBe(US);
    expect(toChatMessage({ id: MSG }).deletedBy).toBeNull();
  });

  it('selects deleted_by with the message columns', () => {
    expect(api.MESSAGE_COLUMNS.split(',')).toContain('deleted_by');
  });
});

describe('wrappers', () => {
  it('deleteMessage sends p_reason only when given', async () => {
    const a = fakeSb({ data: [], error: null });
    await api.deleteMessage(a.sb, MSG);
    expect(a.rpcs[0].args).toEqual({ p_message: MSG });
    const b = fakeSb({ data: [], error: null });
    await api.deleteMessage(b.sb, MSG, 'spam links');
    expect(b.rpcs[0].args).toEqual({ p_message: MSG, p_reason: 'spam links' });
  });

  it('deleteMessageAndFiles posts a JSON reason only when given', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = (async (u: string, init?: RequestInit) => {
      calls.push([u, init]);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await api.deleteMessageAndFiles(MSG, f);
    await api.deleteMessageAndFiles(MSG, f, 'abusive');
    expect(calls[0][1]).toEqual({ method: 'POST' });
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
      reason: 'abusive',
    });
  });

  it('setChannelAudience maps empty teams to null', async () => {
    const t = fakeSb();
    await api.setChannelAudience(t.sb, CH, { minRole: 'agent', teamIds: [] });
    await api.setChannelAudience(t.sb, CH, { minRole: null, teamIds: ['t1'] });
    expect(t.rpcs.map((r) => r.args)).toEqual([
      { p_channel: CH, p_min_role: 'agent', p_team_ids: null },
      { p_channel: CH, p_min_role: null, p_team_ids: ['t1'] },
    ]);
    expect(t.rpcs[0].fn).toBe('chat_set_channel_audience');
  });

  it('channelTeams lists team ids of the channel', async () => {
    const t = fakeSb({
      data: [{ team_id: 't1' }, { team_id: 't2' }],
      error: null,
    });
    expect(await api.channelTeams(t.sb, CH)).toEqual(['t1', 't2']);
    expect(t.chain[0].args).toEqual(['chat_channel_teams']);
  });

  it('restrictMember passes null until and reason', async () => {
    const t = fakeSb();
    await api.restrictMember(t.sb, {
      channelId: CH,
      userId: US,
      until: '2026-11-01T00:00:00Z',
      reason: 'flooding',
    });
    await api.restrictMember(t.sb, { channelId: CH, userId: US, until: null });
    expect(t.rpcs[0]).toEqual({
      fn: 'chat_restrict_member',
      args: {
        p_channel: CH,
        p_user: US,
        p_until: '2026-11-01T00:00:00Z',
        p_reason: 'flooding',
      },
    });
    expect(t.rpcs[1].args).toMatchObject({ p_until: null, p_reason: null });
  });

  it('exportChannel parses tolerantly', async () => {
    const t = fakeSb({
      data: {
        channel: { id: CH, kind: 'team', name: 'Sales', topic: null },
        messages: [
          {
            id: MSG,
            author_kind: 'user',
            author_name: 'Sara',
            body: 'hi',
            created_at: '2026-10-01T10:00:00Z',
            attachments: [
              { name: 'a.pdf', mime: 'application/pdf', bytes: '12' },
            ],
          },
          null,
        ],
        truncated: true,
      },
      error: null,
    });
    const out = await api.exportChannel(t.sb, {
      channelId: CH,
      reason: 'audit 1',
    });
    expect(t.rpcs[0].args).toEqual({
      p_channel: CH,
      p_from: null,
      p_to: null,
      p_reason: 'audit 1',
    });
    expect(out.truncated).toBe(true);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({
      authorName: 'Sara',
      threadRootId: null,
      deletedAt: null,
      attachments: [
        { name: 'a.pdf', bytes: 12, kind: 'file', durationMs: null },
      ],
    });
    expect(api.parseChannelExport(null).messages).toEqual([]);
  });
});

describe('export csv', () => {
  const base = api.parseChannelExport({
    channel: { id: CH, kind: 'team', name: 'Sales' },
    messages: [
      {
        id: '1',
        author_name: 'Sara',
        body: 'مرحبا, "hello"\nline2',
        created_at: '2026-10-01T21:30:00Z',
        thread_root_id: 'root',
        reply_to_id: 'q',
        edited_at: '2026-10-01T22:00:00Z',
        attachments: [{ name: 'a.pdf' }, { name: 'b.png' }],
      },
      {
        id: '2',
        author_kind: 'system',
        body: '',
        created_at: '2026-10-02T00:00:00Z',
        deleted_at: '2026-10-02T01:00:00Z',
      },
      {
        id: '3',
        author_id: US,
        body: '[erased]',
        created_at: '2026-10-02T00:00:00Z',
        erased_at: 'x',
        deleted_at: 'y',
      },
    ],
  });

  it('starts with a BOM and the header, quotes per RFC 4180', () => {
    const csv = exportToCsv(base);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'time,thread,reply to,author,body,attachments,edited at,status'
    );
    expect(csv).toContain('"مرحبا, ""hello""\nline2"');
    expect(csv).toContain('a.pdf; b.png');
    expect(csv).toContain('2026-10-01 21:30:00,root,q,Sara,');
  });

  it('defuses spreadsheet formulas in body, author and attachment names', () => {
    const msg = (over: Record<string, unknown>) => ({
      id: 'm',
      createdAt: '2026-10-01T00:00:00Z',
      threadRootId: null,
      replyToId: null,
      authorId: US,
      authorName: 'Sara',
      authorKind: 'user',
      body: 'hi',
      attachments: [],
      editedAt: null,
      deletedAt: null,
      erasedAt: null,
      ...over,
    });
    const csv = exportToCsv({
      messages: [
        msg({ body: '=HYPERLINK("http://x")', authorName: '+1 555' }),
        msg({ body: '@SUM(1)', attachments: [{ name: '-cmd.xls' }] }),
        msg({ body: '\tTabbed' }),
        msg({ body: 'safe = fine' }),
      ],
    } as unknown as Parameters<typeof exportToCsv>[0]);
    expect(csv).toContain(`'+1 555,"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain("'@SUM(1),'-cmd.xls");
    expect(csv).toContain("'\tTabbed");
    expect(csv).toContain(',safe = fine,');
  });

  it('marks deleted, erased and system rows; honours the time zone', () => {
    const csv = exportToCsv(base, { timeZone: 'Asia/Dubai' });
    expect(csv).toContain('2026-10-02 01:30:00,root,q,Sara,'); // 21:30Z + 4h
    expect(csv).toContain('2026-10-02 04:00:00,,,System,,,,deleted');
    expect(csv).toContain(`,${US},[erased],,,erased`);
  });

  it('falls back to UTC for a bad time zone', () => {
    expect(exportToCsv(base, { timeZone: 'Nope/Zone' })).toContain(
      '2026-10-01 21:30:00'
    );
  });

  it('builds a safe ASCII file name', () => {
    expect(
      exportFileName('Sales / VIP عربي', '2026-10-01T00:00:00Z', '2026-10-30')
    ).toBe('chat-sales-vip-2026-10-01_to_2026-10-30.csv');
    expect(exportFileName(null)).toBe('chat-channel.csv');
    expect(exportFileName('../../etc', '2026-10-01')).toBe(
      'chat-etc-from_2026-10-01.csv'
    );
  });
});
