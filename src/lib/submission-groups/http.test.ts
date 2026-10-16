import { describe, expect, it } from 'vitest';

import { GROUP_SEND_LIMIT } from '@/lib/groups/member-requests';

import {
  accessErrorFor,
  isOverSendLimit,
  isUuid,
  ownGroup,
  parseAccessRemove,
  parseAccessSet,
  parseSendText,
  sendErrorFor,
  sendWindowStart,
  SG_TEXT_MAX,
  SgHttpError,
} from './http';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
} from './service';
import { SubmissionGroupDbError, type SubmissionGroup } from './store';

const U = '44444444-4444-4444-8444-444444444444';
const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof SgHttpError ? err.status : 'other';
  }
  return 'none';
};

describe('isUuid', () => {
  it('accepts a uuid and nothing else', () => {
    expect(isUuid(U)).toBe(true);
    expect(isUuid(U.toUpperCase())).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(`${U}x`)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe('ownGroup', () => {
  const g = { id: 'g', accountId: 'acct-1' } as SubmissionGroup;
  it('returns a group of the caller’s account', () => {
    expect(ownGroup(g, 'acct-1')).toBe(g);
  });
  it('is 404 for a missing group or another account’s', () => {
    expect(statusOf(() => ownGroup(null, 'acct-1'))).toBe(404);
    expect(statusOf(() => ownGroup(g, 'acct-2'))).toBe(404);
  });
});

describe('parseSendText', () => {
  it('trims', () => {
    expect(parseSendText({ text: '  hi \n' })).toEqual({ text: 'hi' });
  });
  it('is 400 for empty, non-string, oversized or missing bodies', () => {
    expect(statusOf(() => parseSendText({ text: '   ' }))).toBe(400);
    expect(statusOf(() => parseSendText({ text: 5 }))).toBe(400);
    expect(statusOf(() => parseSendText(null))).toBe(400);
    expect(
      statusOf(() => parseSendText({ text: 'a'.repeat(SG_TEXT_MAX + 1) }))
    ).toBe(400);
  });
  it('accepts exactly the maximum', () => {
    const text = 'a'.repeat(SG_TEXT_MAX);
    expect(parseSendText({ text })).toEqual({ text });
  });
});

describe('parseAccessSet / parseAccessRemove', () => {
  it('accepts a uuid and a staff label', () => {
    expect(parseAccessSet({ user_id: U, label: 'team_lead' })).toEqual({
      userId: U,
      label: 'team_lead',
    });
  });
  it('is 400 for a bad user id or a non-staff label', () => {
    expect(
      statusOf(() => parseAccessSet({ user_id: 'x', label: 'agent' }))
    ).toBe(400);
    expect(statusOf(() => parseAccessSet({ user_id: U, label: 'admin' }))).toBe(
      400
    );
    expect(statusOf(() => parseAccessSet([U, 'agent']))).toBe(400);
  });
  it('reads user_id from the query', () => {
    expect(parseAccessRemove(new URLSearchParams(`user_id=${U}`))).toEqual({
      userId: U,
    });
    expect(statusOf(() => parseAccessRemove(new URLSearchParams()))).toBe(400);
  });
});

describe('send limit', () => {
  it('starts the window one window before now', () => {
    const now = Date.UTC(2026, 9, 16, 12, 0, 0);
    expect(sendWindowStart(now)).toBe(
      new Date(now - GROUP_SEND_LIMIT.windowMs).toISOString()
    );
  });
  it('is over at the limit, not below', () => {
    expect(isOverSendLimit(GROUP_SEND_LIMIT.perWindow - 1)).toBe(false);
    expect(isOverSendLimit(GROUP_SEND_LIMIT.perWindow)).toBe(true);
    expect(isOverSendLimit(null)).toBe(false);
  });
});

describe('sendErrorFor', () => {
  it.each([
    ['GROUP_NOT_FOUND', 404],
    ['GROUP_NOT_READY', 409],
    ['SEND_NOT_ALLOWED', 403],
    ['UNKNOWN_USER', 403],
  ] as const)('maps %s to %i', (reason, status) => {
    expect(
      sendErrorFor(new SubmissionGroupSendRefusedError(reason)).status
    ).toBe(status);
  });
  it('maps a consent block to 409 with the reason', () => {
    const e = sendErrorFor(
      new SubmissionGroupSendBlockedError('do_not_contact')
    );
    expect(e.status).toBe(409);
    expect(e.body).toMatchObject({ reason: 'do_not_contact' });
  });
  it('maps a sent-but-unrecorded send to 202 sent:true (no resend invited)', () => {
    const e = sendErrorFor(
      new SubmissionGroupSentNotRecordedError('m-1', 'wamid.1', null)
    );
    expect(e.status).toBe(202);
    expect(e.body).toEqual({ error: 'Sent, but not recorded yet', sent: true });
  });
  it('maps anything else to a generic 502', () => {
    const e = sendErrorFor(new Error('whapi: token abc'));
    expect(e.status).toBe(502);
    expect(e.message).not.toContain('abc');
  });
});

describe('accessErrorFor', () => {
  const db = (code: string | null) => new SubmissionGroupDbError('x', code);
  it('maps the SQL codes', () => {
    expect(accessErrorFor(db('55000'))?.status).toBe(409);
    expect(accessErrorFor(db('55000'))?.message).toBe('This group has ended');
    expect(accessErrorFor(db('P0001'))?.status).toBe(422);
    expect(accessErrorFor(db('23514'))?.status).toBe(422);
    expect(accessErrorFor(db('23503'))?.status).toBe(422);
    expect(accessErrorFor(db('22P02'))?.status).toBe(400);
  });
  it('leaves other failures to the generic handler', () => {
    expect(accessErrorFor(db('XX000'))).toBeNull();
    expect(accessErrorFor(db(null))).toBeNull();
    expect(accessErrorFor(new Error('x'))).toBeNull();
  });
  it('passes an SgHttpError through', () => {
    const e = new SgHttpError(400, 'bad');
    expect(accessErrorFor(e)).toBe(e);
  });
});
