import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUDIT_MAX_PAGE,
  AUDIT_SOURCES,
  idsToName,
  mergeAuditPage,
  nameAuditRows,
  parseAuditQuery,
  perSourceLimit,
  shapeAuditRow,
  type AuditRow,
} from './view';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-01T09:00:00+00:00';

const q = (s: string) => new URLSearchParams(s);

describe('shapeAuditRow', () => {
  it('reads a private team chat read: channel and reason', () => {
    expect(
      shapeAuditRow('team_chat', {
        id: 'x1',
        actor_id: A,
        action: 'admin_read_private',
        channel_id: B,
        at: AT,
        detail: { reason: ' Complaint review ' },
      })
    ).toEqual({
      key: 'team_chat:x1',
      source: 'team_chat',
      at: AT,
      actorId: A,
      action: 'admin_read_private',
      item: { kind: 'channel', id: B },
      reason: 'Complaint review',
      facts: [],
    });
  });

  it('reads an erasure: the person erased and the counts', () => {
    const row = shapeAuditRow('team_chat', {
      id: 'x2',
      actor_id: A,
      action: 'erase_person',
      channel_id: null,
      at: AT,
      detail: {
        user_id: C,
        reason: 'GDPR request',
        messages: 12,
        attachments: 3,
      },
    });
    expect(row?.item).toEqual({ kind: 'person', id: C });
    expect(row?.reason).toBe('GDPR request');
    expect(row?.facts).toEqual([
      { key: 'messages', count: 12 },
      { key: 'files', count: 3 },
    ]);
  });

  it('reads a role change as person plus from → to', () => {
    const row = shapeAuditRow('team_chat', {
      id: 'x3',
      actor_id: A,
      action: 'set_member_role',
      channel_id: B,
      at: AT,
      detail: { user_id: C, from: 'member', to: 'admin' },
    });
    expect(row?.item).toEqual({ kind: 'person', id: C });
    expect(row?.facts).toEqual([
      { key: 'change', from: 'member', to: 'admin' },
    ]);
  });

  it('reads a recording access by its user_id column', () => {
    expect(
      shapeAuditRow('recordings', {
        id: 42,
        call_id: B,
        user_id: A,
        action: 'download',
        at: AT,
      })
    ).toMatchObject({
      key: 'recordings:42',
      actorId: A,
      item: { kind: 'call', id: B },
      reason: null,
    });
  });

  it('reads a call erasure and a do-not-contact override', () => {
    expect(
      shapeAuditRow('phone', {
        id: 7,
        actor_id: A,
        action: 'erase_contact_calls',
        contact_id: B,
        call_ids: [C, C],
        reason: 'Customer request',
        detail: { recordings: 2 },
        at: AT,
      })
    ).toMatchObject({
      item: { kind: 'contact', id: B },
      reason: 'Customer request',
      facts: [
        { key: 'recordings', count: 2 },
        { key: 'calls', count: 2 },
      ],
    });
    expect(
      shapeAuditRow('phone', {
        id: 8,
        actor_id: A,
        action: 'dnc_override_call',
        contact_id: B,
        call_ids: [],
        reason: 'Asked to be called back',
        detail: { number: '+971501234567' },
        at: AT,
      })?.facts
    ).toEqual([{ key: 'number', value: '+971501234567' }]);
  });

  it('reads a deal room change; the server acting has no actor', () => {
    expect(
      shapeAuditRow('deal_rooms', {
        id: 'd1',
        room_id: B,
        actor_id: null,
        action: 'status_changed',
        at: AT,
        detail: { from: 'open', to: 'closed' },
      })
    ).toMatchObject({
      actorId: null,
      item: { kind: 'deal_room', id: B },
      facts: [{ key: 'change', from: 'open', to: 'closed' }],
    });
  });

  it('reads a removal (091) like add_members: the channel and one member', () => {
    expect(
      shapeAuditRow('team_chat', {
        id: 'x5',
        actor_id: A,
        action: 'remove_member',
        channel_id: B,
        at: AT,
        detail: { user_id: C, role: 'member' },
      })
    ).toMatchObject({
      item: { kind: 'channel', id: B },
      reason: null,
      facts: [{ key: 'members', count: 1 }],
    });
    expect(
      shapeAuditRow('team_chat', {
        id: 'x6',
        action: 'remove_member',
        channel_id: B,
        at: AT,
        detail: { user_id: 'junk' },
      })
    ).toMatchObject({ item: { kind: 'channel', id: B }, facts: [] });
  });

  it('reads a channel edit (091) as the old and new name and topic, where changed', () => {
    const edit = (detail: Record<string, unknown>) =>
      shapeAuditRow('team_chat', {
        id: 'x7',
        actor_id: A,
        action: 'update_channel',
        channel_id: B,
        at: AT,
        detail,
      });
    expect(
      edit({ from: 'sales', to: 'sales-uae', topic_from: null, topic_to: 'Q4' })
    ).toMatchObject({
      item: { kind: 'channel', id: B },
      reason: null,
      facts: [
        { key: 'rename', from: 'sales', to: 'sales-uae' },
        { key: 'topic', from: null, to: 'Q4' },
      ],
    });
    // A topic-only edit stores the name twice; a cleared topic is null.
    expect(
      edit({ from: 'sales', to: 'sales', topic_from: 'Q4', topic_to: null })
        ?.facts
    ).toEqual([{ key: 'topic', from: 'Q4', to: null }]);
    expect(
      edit({ from: 'a', to: 'b', topic_from: 'same', topic_to: 'same' })?.facts
    ).toEqual([{ key: 'rename', from: 'a', to: 'b' }]);
  });

  it('labels every team-chat action the latest audit CHECK allows, in en and ko', () => {
    // Whichever migration last (re)defines chat_audit_log's action
    // CHECK, so a new action cannot ship without its label.
    const dir = join(process.cwd(), 'supabase/migrations');
    const re = /chat_audit_log_action_check CHECK \(action IN \(([^)]*)\)/;
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .flatMap((f) => {
        const m = re.exec(readFileSync(join(dir, f), 'utf8'));
        return m ? [{ file: f, list: m[1] }] : [];
      })
      .at(-1);
    expect(Number(latest?.file.slice(0, 3))).toBeGreaterThanOrEqual(91);
    const actions = [...(latest?.list ?? '').matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1]
    );
    expect(actions).toContain('remove_member');
    for (const lang of ['en', 'ko']) {
      const labels = JSON.parse(
        readFileSync(join(process.cwd(), `messages/${lang}.json`), 'utf8')
      ).Settings.auditLog.actions.team_chat;
      expect(actions.filter((a) => !labels[a])).toEqual([]);
    }
  });

  it('drops a row with no id, time or action, and ignores junk detail', () => {
    expect(shapeAuditRow('phone', { id: 1, action: 'x' })).toBeNull();
    const row = shapeAuditRow('team_chat', {
      id: 'x9',
      actor_id: 'not-a-uuid',
      action: 'add_members',
      channel_id: 'nope',
      at: AT,
      detail: ['junk'],
    });
    expect(row).toMatchObject({ actorId: null, item: null, facts: [] });
  });
});

function row(source: AuditRow['source'], id: string, at: string): AuditRow {
  return {
    key: `${source}:${id}`,
    source,
    at,
    actorId: null,
    action: 'x',
    item: null,
    reason: null,
    facts: [],
  };
}

describe('mergeAuditPage', () => {
  it('merges the sources newest first and pages by the size', () => {
    const chat = [row('team_chat', 'a', '2026-10-05T10:00:00Z')];
    const phone = [
      row('phone', 'b', '2026-10-06T10:00:00Z'),
      row('phone', 'c', '2026-10-01T10:00:00Z'),
    ];
    const deal = [row('deal_rooms', 'd', '2026-10-03T10:00:00+04:00')];
    const first = mergeAuditPage([chat, phone, deal], 1, 2);
    expect(first.rows.map((r) => r.key)).toEqual(['phone:b', 'team_chat:a']);
    expect(first.hasMore).toBe(true);
    const second = mergeAuditPage([chat, phone, deal], 2, 2);
    expect(second.rows.map((r) => r.key)).toEqual(['deal_rooms:d', 'phone:c']);
    expect(second.hasMore).toBe(false);
  });

  it('orders equal times stably and asks each source for page × size + 1', () => {
    const t = '2026-10-05T10:00:00Z';
    const { rows } = mergeAuditPage(
      [
        [row('phone', '2', t)],
        [row('deal_rooms', '9', t), row('phone', '1', t)],
      ],
      1
    );
    expect(rows.map((r) => r.key)).toEqual([
      'deal_rooms:9',
      'phone:1',
      'phone:2',
    ]);
    expect(perSourceLimit(1)).toBe(51);
    expect(perSourceLimit(3)).toBe(151);
  });
});

describe('parseAuditQuery', () => {
  it('defaults to every source, no range, anyone, page 1', () => {
    expect(parseAuditQuery(q(''))).toEqual({
      sources: [...AUDIT_SOURCES],
      from: null,
      to: null,
      actorId: null,
      page: 1,
    });
    expect(parseAuditQuery(q('source=all'))).toMatchObject({
      sources: [...AUDIT_SOURCES],
    });
  });

  it('narrows to one source, a range and a person', () => {
    expect(
      parseAuditQuery(
        q(
          `source=recordings&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&actor=${A.toUpperCase()}&page=3`
        )
      )
    ).toEqual({
      sources: ['recordings'],
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      actorId: A,
      page: 3,
    });
  });

  it('refuses a bad source, range, person or page', () => {
    for (const bad of [
      'source=calls',
      'from=yesterday',
      'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
      'actor=bob',
      'page=0',
      'page=1.5',
      `page=${AUDIT_MAX_PAGE + 1}`,
    ]) {
      expect(typeof parseAuditQuery(q(bad)), bad).toBe('string');
    }
  });
});

describe('naming', () => {
  it('collects actors and items, and names them, a person from people', () => {
    const rows: AuditRow[] = [
      {
        ...row('team_chat', '1', AT),
        actorId: A,
        item: { kind: 'person', id: C },
      },
      {
        ...row('recordings', '2', AT),
        actorId: B,
        item: { kind: 'call', id: C },
      },
    ];
    const ids = idsToName(rows);
    expect(ids.people.sort()).toEqual([A, B, C].sort());
    expect(ids.byKind.call).toEqual([C]);
    const named = nameAuditRows(
      rows,
      new Map([
        [A, 'Amina'],
        [C, 'Chen'],
      ]),
      new Map([[`call:${C}`, 'Rashid · +971…']])
    );
    expect(named.map((r) => [r.actorName, r.itemLabel])).toEqual([
      ['Amina', 'Chen'],
      [null, 'Rashid · +971…'],
    ]);
  });
});
