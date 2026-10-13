import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { addOrCreateMember } from '@/lib/account/add-member';
import {
  MAX_INVITES,
  afterCreatePath,
  badgeFor,
  inviteRowsToPayload,
  isNoLoginError,
  parseWorkspaceBadges,
  planWorkspaceRename,
  shortNameError,
  showWorkspaceRail,
  suggestPassword,
  suggestShortName,
  validateInviteRows,
  workspaceNameError,
  type InviteRow,
} from './form';

function row(over: Partial<InviteRow> & { id: string }): InviteRow {
  return { email: '', role: 'agent', bankCode: '', ...over };
}

describe('suggestShortName', () => {
  it('takes the initials of a several-word name', () => {
    expect(suggestShortName('Taamul Connect')).toBe('TC');
    expect(suggestShortName('taamul partners')).toBe('TP');
  });

  it('stops at four letters', () => {
    expect(suggestShortName('Al Rostamani Group Trading Company')).toBe('ARGT');
  });

  it('gives a one-word name its first two characters', () => {
    expect(suggestShortName('Taamul')).toBe('TA');
    expect(suggestShortName('X')).toBe('X');
  });

  it('splits on punctuation and keeps only ASCII letters and digits', () => {
    expect(suggestShortName('  Mashreq-Neo / 2026 ')).toBe('MN2');
    expect(suggestShortName('شركة تعامل')).toBe('');
    expect(suggestShortName('')).toBe('');
  });

  it('always suggests something the short-name rule accepts', () => {
    for (const name of ['Taamul Connect', 'A b c d e f', 'Q7', 'one']) {
      expect(shortNameError(suggestShortName(name))).toBeNull();
    }
  });
});

describe('workspace name rules', () => {
  it('needs a trimmed name of 1–80 characters', () => {
    expect(workspaceNameError('   ')).toBe('nameRequired');
    expect(workspaceNameError('x'.repeat(81))).toBe('nameTooLong');
    expect(workspaceNameError(`  ${'x'.repeat(80)}  `)).toBeNull();
  });

  it('needs a short name of one to four letters or digits', () => {
    expect(shortNameError('TC')).toBeNull();
    expect(shortNameError('T2c9')).toBeNull();
    expect(shortNameError('')).toBe('shortNameInvalid');
    expect(shortNameError('TCONN')).toBe('shortNameInvalid');
    expect(shortNameError('T C')).toBe('shortNameInvalid');
    expect(shortNameError('تع')).toBe('shortNameInvalid');
  });
});

describe('planWorkspaceRename', () => {
  const saved = { name: 'Taamul Connect', shortName: 'TC' };

  it('sends nothing while nothing changed, spaces aside', () => {
    expect(
      planWorkspaceRename(saved, { name: ' Taamul Connect ', shortName: 'TC ' })
    ).toEqual({ nameError: null, shortNameError: null, payload: null });
  });

  it('sends only the changed field, trimmed', () => {
    expect(
      planWorkspaceRename(saved, { name: '  Taamul ', shortName: 'TC' }).payload
    ).toEqual({ name: 'Taamul' });
    expect(
      planWorkspaceRename(saved, { name: 'Taamul Connect', shortName: ' tc2 ' })
        .payload
    ).toEqual({ short_name: 'tc2' });
    expect(
      planWorkspaceRename(saved, { name: 'Taamul', shortName: 'TA' }).payload
    ).toEqual({ name: 'Taamul', short_name: 'TA' });
  });

  it('names the wrong field and sends nothing', () => {
    expect(planWorkspaceRename(saved, { name: '  ', shortName: 'TC' })).toEqual(
      { nameError: 'nameRequired', shortNameError: null, payload: null }
    );
    expect(
      planWorkspaceRename(saved, { name: 'x'.repeat(81), shortName: 'T C' })
    ).toEqual({
      nameError: 'nameTooLong',
      shortNameError: 'shortNameInvalid',
      payload: null,
    });
    // Clearing a short name is not allowed: the server needs 1–4.
    expect(
      planWorkspaceRename(saved, { name: 'Taamul', shortName: '' })
    ).toEqual({
      nameError: null,
      shortNameError: 'shortNameInvalid',
      payload: null,
    });
  });

  it('checks only what changed, so a missing short name does not block a rename', () => {
    const legacy = { name: 'Old', shortName: null };
    expect(planWorkspaceRename(legacy, { name: 'New', shortName: '' })).toEqual(
      { nameError: null, shortNameError: null, payload: { name: 'New' } }
    );
    expect(
      planWorkspaceRename(legacy, { name: 'Old', shortName: 'OL' }).payload
    ).toEqual({ short_name: 'OL' });
  });
});

describe('validateInviteRows', () => {
  it('skips blank rows rather than flagging them', () => {
    const result = validateInviteRows([row({ id: 'a', email: '   ' })]);
    expect(result).toEqual({ ok: true, rowErrors: {}, tooMany: false });
  });

  it('flags a malformed email', () => {
    const result = validateInviteRows([
      row({ id: 'a', email: 'ali@' }),
      row({ id: 'b', email: 'sara@taamul.ae' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.rowErrors).toEqual({ a: 'email' });
  });

  it('flags the second copy of an email, whatever its case', () => {
    const result = validateInviteRows([
      row({ id: 'a', email: 'Sara@Taamul.ae' }),
      row({ id: 'b', email: ' sara@taamul.ae ' }),
    ]);
    expect(result.rowErrors).toEqual({ b: 'duplicate' });
  });

  it('needs a bank code on a bank guest, and only there', () => {
    const result = validateInviteRows([
      row({ id: 'a', email: 'rm@mashreq.com', role: 'bank_guest' }),
      row({
        id: 'b',
        email: 'x@mashreq.com',
        role: 'bank_guest',
        bankCode: ' ',
      }),
      row({
        id: 'c',
        email: 'ok@mashreq.com',
        role: 'bank_guest',
        bankCode: 'MSHQ',
      }),
      row({ id: 'd', email: 'agent@taamul.ae', role: 'agent' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.rowErrors).toEqual({ a: 'bankCode', b: 'bankCode' });
  });

  it(`refuses more than ${MAX_INVITES} filled rows`, () => {
    const rows = Array.from({ length: MAX_INVITES + 1 }, (_, i) =>
      row({ id: String(i), email: `p${i}@taamul.ae` })
    );
    expect(validateInviteRows(rows.slice(0, MAX_INVITES)).ok).toBe(true);
    const result = validateInviteRows([...rows, row({ id: 'blank' })]);
    expect(result.tooMany).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('inviteRowsToPayload', () => {
  it('drops blank rows, normalises emails and sends a bank code only for a guest', () => {
    expect(
      inviteRowsToPayload([
        row({
          id: 'a',
          email: ' Sara@Taamul.ae ',
          role: 'admin',
          bankCode: 'X',
        }),
        row({ id: 'b', email: '' }),
        row({
          id: 'c',
          email: 'rm@mashreq.com',
          role: 'bank_guest',
          bankCode: ' MSHQ ',
        }),
      ])
    ).toEqual([
      { email: 'sara@taamul.ae', role: 'admin' },
      { email: 'rm@mashreq.com', role: 'bank_guest', bankCode: 'MSHQ' },
    ]);
  });
});

describe('isNoLoginError', () => {
  it('recognises the message addOrCreateMember answers for an unknown email', async () => {
    // add_workspace_member says no_such_user, and no password was given:
    // the exact sentence the API sends back to the dialogs.
    const supabase = {
      rpc: async () => ({
        data: null,
        error: { code: 'P0002', message: 'no_such_user' },
      }),
    } as unknown as SupabaseClient;
    const result = await addOrCreateMember({
      supabase,
      admin: supabase,
      accountId: 'acc-1',
      email: 'new@taamul.ae',
      role: 'agent',
      mayCreateLogin: true,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && isNoLoginError(result.error)).toBe(true);
  });

  it('ignores every other failure', () => {
    expect(isNoLoginError('That email already has an account')).toBe(false);
    expect(isNoLoginError('This person is already a member')).toBe(false);
    expect(isNoLoginError(undefined)).toBe(false);
  });
});

describe('afterCreatePath', () => {
  it('opens the WhatsApp settings when a number is to be connected', () => {
    expect(afterCreatePath('meta')).toBe('/settings?tab=whatsapp');
    expect(afterCreatePath('whapi')).toBe('/settings?tab=whatsapp');
    expect(afterCreatePath('skip')).toBe('/dashboard');
  });
});

describe('showWorkspaceRail', () => {
  it('shows only when there is another workspace or a "+" tile', () => {
    expect(showWorkspaceRail(1, false)).toBe(false);
    expect(showWorkspaceRail(0, false)).toBe(false);
    expect(showWorkspaceRail(2, false)).toBe(true);
    expect(showWorkspaceRail(1, true)).toBe(true);
  });
});

describe('workspace badges', () => {
  const badges = parseWorkspaceBadges([
    { account_id: 'a', unread: 4, mentions: 2 },
    { account_id: 'b', unread: 3, mentions: 0 },
    { account_id: 'c', unread: 0, mentions: 0 },
    { account_id: '', unread: 9, mentions: 9 },
    { unread: 1 },
    null,
    { account_id: 'd', unread: '7', mentions: -1 },
  ]);

  it('parses rows tolerantly', () => {
    expect(badges).toEqual([
      { accountId: 'a', unread: 4, mentions: 2 },
      { accountId: 'b', unread: 3, mentions: 0 },
      { accountId: 'c', unread: 0, mentions: 0 },
      { accountId: 'd', unread: 7, mentions: 0 },
    ]);
    expect(parseWorkspaceBadges({ message: 'boom' })).toEqual([]);
    expect(parseWorkspaceBadges(null)).toEqual([]);
  });

  it('prefers mentions, then unread, then nothing', () => {
    expect(badgeFor('a', badges)).toEqual({ kind: 'mentions', count: 2 });
    expect(badgeFor('b', badges)).toEqual({ kind: 'unread', count: 3 });
    expect(badgeFor('c', badges)).toBeNull();
    expect(badgeFor('missing', badges)).toBeNull();
    expect(badgeFor('a', [])).toBeNull();
  });
});

describe('suggestPassword', () => {
  it('is long enough to create a login', () => {
    expect(suggestPassword()).toMatch(/^[A-Za-z2-9]{14}$/);
  });
});
