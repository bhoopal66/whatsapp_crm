import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCOUNT_ROLES } from '@/lib/auth/roles';
import type { GroupOutcome, GroupWallRow } from '@/lib/desk/group-intake-store';
import { GROUP_INTAKE_OUTCOMES } from '@/lib/desk/group-intake-store';
import { QUEUE_REASON_TEXT, REFUSAL_TEXT } from '@/lib/desk/group-intake-text';

import { isWallFile } from './wall';
import {
  WALL_QUEUE_HREF,
  WALL_QUEUE_REASONS,
  WALL_REFUSAL_REASONS,
  WALL_TONE_CLASS,
  canLinkWallGroup,
  wallAge,
  wallFileTag,
  wallNoCoordinator,
  wallOutcomeIds,
  wallQueueChip,
  wallRepliedNote,
} from './wall-desk';

function outcome(over: Partial<GroupOutcome> = {}): GroupOutcome {
  return {
    groupMessageId: 'm1',
    outcome: 'filed',
    detail: null,
    replyState: 'off',
    itemState: 'filed',
    caseNumber: 'TC-26-00412-RAK',
    captionCode: null,
    docKey: 'ejari',
    queueReason: null,
    ...over,
  };
}

function row(over: Partial<GroupWallRow> = {}): GroupWallRow {
  return {
    groupId: 'g1',
    bankCode: 'RAK',
    bankName: 'RAKBANK',
    shortCode: 'RAK',
    primaryName: 'Asha',
    secondName: 'Bilal',
    filedToday: 3,
    toSort: 2,
    oldestAgeSeconds: 7800,
    alert: 'none',
    ...over,
  };
}

describe('wallFileTag', () => {
  it('a queued file a coordinator filed later reads Filed with that case', () => {
    expect(
      wallFileTag(
        outcome({
          outcome: 'queued',
          detail: 'NO_CASE',
          itemState: 'filed',
          caseNumber: 'TC-26-00500-RAK',
          docKey: 'trade_licence',
        })
      )
    ).toEqual({
      kind: 'filed',
      tone: 'success',
      caseNumber: 'TC-26-00500-RAK',
      docKey: 'trade_licence',
    });
  });

  it('a queued file still waiting names the plain reason', () => {
    expect(
      wallFileTag(
        outcome({
          outcome: 'queued',
          itemState: 'untagged',
          caseNumber: null,
          queueReason: 'NO_KIND',
        })
      )
    ).toEqual({ kind: 'queued', tone: 'warning', reason: 'NO_KIND' });
    expect(
      wallFileTag(
        outcome({
          outcome: 'queued',
          itemState: 'untagged',
          detail: 'SOMETHING_NEW',
        })
      )
    ).toMatchObject({ reason: 'other' });
  });

  it('a new case shows its number and caption code', () => {
    expect(
      wallFileTag(outcome({ outcome: 'new_case', captionCode: '412RAKX' }))
    ).toEqual({
      kind: 'new_case',
      tone: 'info',
      caseNumber: 'TC-26-00412-RAK',
      captionCode: '412RAKX',
    });
  });

  it('every other outcome has a word; chat and nothing have no tag', () => {
    const kinds = GROUP_INTAKE_OUTCOMES.map((o) =>
      wallFileTag(
        outcome({ outcome: o, itemState: null, detail: 'BANK_UNKNOWN' })
      )
    ).map((t) => t?.kind ?? null);
    expect(kinds).toEqual([
      'filed',
      'new_case',
      'queued',
      'duplicate',
      'refused',
      'unknown_sender',
      'no_copy',
      'file_type',
      null,
    ]);
    expect(wallFileTag(undefined)).toBeNull();
    expect(
      wallFileTag(
        outcome({ outcome: 'refused', itemState: null, detail: 'BANK_UNKNOWN' })
      )
    ).toMatchObject({ kind: 'refused', reason: 'BANK_UNKNOWN' });
    expect(
      wallFileTag(
        outcome({ outcome: 'refused', itemState: null, detail: 'REJECTED' })
      )
    ).toMatchObject({ reason: 'other' });
  });

  it('every tone carries a status token for its word', () => {
    for (const o of GROUP_INTAKE_OUTCOMES) {
      const tag = wallFileTag(outcome({ outcome: o, itemState: null }));
      if (tag)
        expect(WALL_TONE_CLASS[tag.tone]).toMatch(/^bg-\w+-soft text-\w+$/);
    }
  });
});

describe('the reason words are the group reply wording', () => {
  const en = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/en.json'), 'utf8')
  ) as { GroupWall: { desk: Record<string, Record<string, string>> } };
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  it('queue reasons', () => {
    for (const code of WALL_QUEUE_REASONS)
      expect(en.GroupWall.desk.queueReasons[code]).toBe(
        capital(QUEUE_REASON_TEXT[code])
      );
    expect(en.GroupWall.desk.queueReasons.other).toBeTruthy();
  });

  it('refusal reasons', () => {
    for (const code of WALL_REFUSAL_REASONS)
      expect(en.GroupWall.desk.refusalReasons[code]).toBe(
        capital(REFUSAL_TEXT[code])
      );
    expect(en.GroupWall.desk.refusalReasons.other).toBeTruthy();
  });
});

describe('header and footer', () => {
  it('the queue chip turns red with the oldest age on a second or lead alert', () => {
    expect(wallQueueChip(row())).toEqual({ count: 2, alert: false, age: null });
    expect(wallQueueChip(row({ alert: 'second' }))).toEqual({
      count: 2,
      alert: true,
      age: { hours: 2, minutes: '10' },
    });
    expect(
      wallQueueChip(row({ alert: 'lead', oldestAgeSeconds: 4 * 3600 + 300 }))
    ).toMatchObject({ alert: true, age: { hours: 4, minutes: '05' } });
    expect(wallQueueChip(row({ alert: 'no_coordinator' })).alert).toBe(false);
  });

  it('ages read in hours and minutes', () => {
    expect(wallAge(45 * 60)).toEqual({ hours: 0, minutes: '45' });
    expect(wallAge(null)).toBeNull();
    expect(wallAge(-1)).toBeNull();
  });

  it('no coordinator', () => {
    expect(wallNoCoordinator(row({ alert: 'no_coordinator' }))).toBe(true);
    expect(
      wallNoCoordinator(row({ primaryName: null, secondName: null }))
    ).toBe(true);
    expect(wallNoCoordinator(row({ secondName: null }))).toBe(false);
  });

  it('the queue link opens the desk sorting queue tab', () => {
    expect(WALL_QUEUE_HREF).toBe('/desk?tab=queue');
  });

  it('replied shows only for a sent reply', () => {
    expect(wallRepliedNote(outcome({ replyState: 'sent' }))).toBe(true);
    for (const s of ['off', 'pending', 'failed'] as const)
      expect(wallRepliedNote(outcome({ replyState: s }))).toBe(false);
    expect(wallRepliedNote(undefined)).toBe(false);
  });
});

describe('canLinkWallGroup', () => {
  it('team leaders and up only', () => {
    const allowed = ACCOUNT_ROLES.filter((r) => canLinkWallGroup(r));
    expect([...allowed].sort()).toEqual(['admin', 'owner', 'team_leader']);
    expect(canLinkWallGroup(null)).toBe(false);
  });
});

describe('wallOutcomeIds', () => {
  it('inbound files only, sorted, with a key that follows the set', () => {
    const msgs = [
      { id: 'b', direction: 'in', type: 'document' },
      { id: 'a', direction: 'in', type: 'image' },
      { id: 'c', direction: 'out', type: 'document' },
      { id: 'd', direction: 'in', type: 'text' },
    ];
    expect(wallOutcomeIds(msgs, isWallFile)).toEqual({
      ids: ['a', 'b'],
      key: 'a,b',
    });
  });
});
