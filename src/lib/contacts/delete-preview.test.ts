import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import ar from '../../../messages/ar.json';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import {
  DELETE_PREVIEW_RPC,
  deleteDialogView,
  deleteRefusal,
  parseDeletePreview,
  reasonsText,
  splitDeletable,
  stayedText,
  type BlockedContact,
  type DeleteText,
} from './delete-preview';

const words = (locale: 'en' | 'ar' | 'ko') =>
  createTranslator({
    locale,
    messages: { en, ar, ko }[locale],
    namespace: 'Contacts.deleteDialog',
  }) as unknown as DeleteText;

const none = { legalHold: false, cases: 0, dealRooms: 0, submissionGroups: 0 };
const held = (id: string): BlockedContact => ({ id, ...none, legalHold: true });
const answer = {
  contacts: 2,
  chats: 3,
  tasks: 0,
  deal_rooms: 1,
  deals: 2,
  documents: 0,
  cases: 1,
  blocked: [
    {
      contact_id: 'b',
      legal_hold: false,
      cases: 2,
      deal_rooms: 1,
      submission_groups: 3,
    },
  ],
};
const blockedB: BlockedContact = {
  id: 'b',
  legalHold: false,
  cases: 2,
  dealRooms: 1,
  submissionGroups: 3,
};
const preview = parseDeletePreview(answer)!;

describe('parseDeletePreview', () => {
  it('reads the counts and each blocked customer’s reasons', () => {
    expect(preview).toEqual({
      chats: 3,
      tasks: 0,
      dealRooms: 1,
      deals: 2,
      documents: 0,
      cases: 1,
      blocked: [blockedB],
    });
  });

  it('refuses what is not the answer', () => {
    for (const bad of [null, undefined, [], 'x', {}, { blocked: 1 }])
      expect(parseDeletePreview(bad)).toBeNull();
  });

  // A renamed key would read as "nothing goes with them".
  it('uses the keys and the name migration 280 uses', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/280_contact_delete.sql'),
      'utf8'
    );
    const fn = sql.slice(sql.indexOf(`public.${DELETE_PREVIEW_RPC}(`));
    for (const key of [...Object.keys(answer), 'contact_id', 'legal_hold'])
      expect(fn).toContain(`'${key}'`);
    for (const key of ['cases', 'deal_rooms', 'submission_groups'])
      expect(sql).toContain(`'${key}', (SELECT count(*)`);
    expect(sql).toContain("ERRCODE = 'ZC280', HINT = 'HAS_OPEN_WORK'");
  });
});

describe('splitDeletable', () => {
  it('leaves the blocked ones out, in the order asked', () => {
    expect(
      splitDeletable(['a', 'b', 'c', 'd'], [held('d'), blockedB, held('z')])
    ).toEqual({ deletable: ['a', 'c'], blocked: [blockedB, held('d')] });
  });
});

describe('deleteDialogView', () => {
  const ready = (p = preview) => ({ kind: 'ready' as const, preview: p });

  it('waits for the preview', () => {
    expect(deleteDialogView(['a'], { kind: 'loading' }).loading).toBe(true);
  });

  it('falls back to the plain question', () => {
    expect(deleteDialogView(['a'], { kind: 'failed' })).toEqual({
      loading: false,
      optOutNote: false,
      deletable: ['a'],
      deleted: [],
      kept: [],
      blocked: [],
      blockedMore: 0,
    });
  });

  it('groups what goes and what stays, without zero counts', () => {
    const view = deleteDialogView(['a'], ready());
    expect(view.deleted).toEqual([
      { kind: 'chats', count: 3 },
      { kind: 'dealRooms', count: 1 },
    ]);
    expect(view.kept).toEqual([
      { kind: 'deals', count: 2 },
      { kind: 'cases', count: 1 },
    ]);
    expect(view.optOutNote).toBe(true);
  });

  it('offers no delete, and no counts, when nobody is left', () => {
    expect(deleteDialogView(['b'], ready())).toEqual({
      loading: false,
      optOutNote: false,
      deletable: [],
      deleted: [],
      kept: [],
      blocked: [blockedB],
      blockedMore: 0,
    });
  });

  it('names the first few blocked and counts the rest', () => {
    const ids = ['a', 'p', 'q', 'r', 's', 't'];
    const blocked = ['p', 'q', 'r', 's', 't'].map(held);
    const view = deleteDialogView(ids, ready({ ...preview, blocked }));
    expect(view.deletable).toEqual(['a']);
    expect(view.blocked.map((b) => b.id)).toEqual(['p', 'q', 'r']);
    expect(view.blockedMore).toBe(2);
  });
});

describe('deleteRefusal', () => {
  it('reads a legal hold', () => {
    expect(deleteRefusal({ code: '55000', hint: 'LEGAL_HOLD' })).toEqual({
      ...none,
      legalHold: true,
    });
  });

  it('reads open work and its counts', () => {
    expect(
      deleteRefusal({
        code: 'ZC280',
        hint: 'HAS_OPEN_WORK',
        details: '{"cases": 1, "deal_rooms": 0, "submission_groups": 2}',
      })
    ).toEqual({ ...none, cases: 1, submissionGroups: 2 });
  });

  it('is open work even without readable counts', () => {
    for (const details of [null, 'x', '[]'])
      expect(deleteRefusal({ code: 'ZC280', details })).toEqual(none);
  });

  it('is nothing for any other failure', () => {
    expect(deleteRefusal({ code: '57014', hint: '' })).toBeNull();
  });
});

describe('the words', () => {
  const all = { legalHold: true, cases: 1, dealRooms: 2, submissionGroups: 1 };

  it('says every reason', () => {
    expect(reasonsText(all, words('en'), 'en')).toBe(
      'a legal hold, 1 open case, 2 open deal rooms, and 1 active submission group'
    );
    expect(reasonsText(none, words('en'), 'en')).toBe('open work');
  });

  it.each(['ar', 'ko'] as const)('in %s too', (locale) => {
    const text = reasonsText(all, words(locale), locale);
    expect(text).not.toMatch(/reason|[a-z]{3}/);
    expect(text.length).toBeGreaterThan(20);
  });

  it('names who stayed and why, then how many more', () => {
    const stayed = {
      refused: [{ ...blockedB, dealRooms: 0, submissionGroups: 0 }, held('c')],
      failed: ['d', 'e', 'f'],
    };
    expect(
      stayedText(stayed, (id) => id.toUpperCase(), words('en'), 'en')
    ).toBe(
      'B (2 open cases), C (a legal hold), D (failed, try again), and 2 more'
    );
  });
});
