import { describe, expect, it } from 'vitest';

import {
  checkIconUpload,
  isFreshInvite,
  parseAddMembers,
  parseGroupText,
  parseInviteAction,
  parseJoinDecision,
  parseManagerSet,
  parseMemberList,
  parseMessagePage,
  parseRoleChange,
  requireGroupAdmin,
} from './member-requests';

const U = '44444444-4444-4444-8444-444444444441';
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status: number; code: string }).status;
  }
  return 'ok';
};

describe('member-requests parsers', () => {
  it('needs at least one recipient, dedupes, checks ids', () => {
    expect(parseAddMembers({ phones: [' 1 ', '1'], contactIds: [U] })).toEqual({
      phones: ['1'],
      contactIds: [U],
    });
    expect(code(() => parseAddMembers({}))).toBe(400);
    expect(code(() => parseAddMembers({ contactIds: ['x'] }))).toBe(400);
    expect(code(() => parseAddMembers([]))).toBe(400);
  });

  it('normalises waIds and refuses a non-number', () => {
    expect(
      parseMemberList({ waIds: ['+971 50 111 1111', '971501111111'] })
    ).toEqual({ waIds: ['971501111111'] });
    expect(code(() => parseMemberList({ waIds: ['abc'] }))).toBe(400);
    expect(code(() => parseRoleChange({ waIds: ['971501111111'] }))).toBe(400);
    expect(
      parseRoleChange({ waIds: ['971501111111'], role: 'admin' }).role
    ).toBe('admin');
  });

  it('parses invite actions', () => {
    expect(parseInviteAction({ action: 'reset' })).toEqual({ action: 'reset' });
    expect(
      parseInviteAction({ action: 'send', phones: ['1'], message: '  ' })
    ).toEqual({ action: 'send', phones: ['1'], contactIds: [], message: null });
    expect(code(() => parseInviteAction({ action: 'send' }))).toBe(400);
    expect(code(() => parseInviteAction({ action: 'x' }))).toBe(400);
  });

  it('parses a join decision, managers, text and a page', () => {
    expect(
      parseJoinDecision({
        applicant: '971501111111@s.whatsapp.net',
        action: 'approve',
      })
    ).toEqual({ applicant: '971501111111', action: 'approve' });
    expect(
      code(() => parseJoinDecision({ applicant: 'x', action: 'approve' }))
    ).toBe(400);
    expect(parseManagerSet({ userIds: [U, U] })).toEqual({ userIds: [U] });
    expect(code(() => parseManagerSet({ userIds: ['me'] }))).toBe(400);
    expect(parseGroupText({ text: ' hi ' })).toEqual({ text: 'hi' });
    expect(code(() => parseGroupText({ text: '' }))).toBe(400);
    expect(parseMessagePage(new URLSearchParams(''))).toEqual({
      before: null,
      limit: 50,
    });
    expect(code(() => parseMessagePage(new URLSearchParams('limit=500')))).toBe(
      400
    );
    expect(code(() => parseMessagePage(new URLSearchParams('before=x')))).toBe(
      400
    );
  });

  it('checks an icon upload', () => {
    const png = new Blob([new Uint8Array(10)], { type: 'image/png' });
    expect(checkIconUpload(png)).toEqual({ mimeType: 'image/png' });
    expect(
      code(() => checkIconUpload(new Blob(['x'], { type: 'image/gif' })))
    ).toBe(400);
    const big = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], {
      type: 'image/jpeg',
    });
    expect(code(() => checkIconUpload(big))).toBe(413);
    expect(code(() => checkIconUpload(null))).toBe(400);
  });

  it('judges invite freshness and group-admin actions', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    expect(isFreshInvite('2026-10-16T11:30:00Z', now)).toBe(true);
    expect(isFreshInvite('2026-10-16T10:59:00Z', now)).toBe(false);
    expect(code(() => requireGroupAdmin({ our_role: 'left' }))).toBe(409);
    expect(code(() => requireGroupAdmin({ our_role: 'member' }))).toBe(403);
    expect(code(() => requireGroupAdmin({ our_role: 'admin' }))).toBe('ok');
  });
});
