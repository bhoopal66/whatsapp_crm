import { describe, expect, it } from 'vitest';

import {
  archiveErrorResponse,
  NOT_AN_OWNER,
  parseArchiveResult,
} from './workspace-archive';

const T = '0b6f7c1e-2f43-4a8e-9d0a-5c1b2e3f4a5b';
const H = '6d0e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';

describe('parseArchiveResult', () => {
  it("reads archive_workspace's result, camelCased", () => {
    expect(
      parseArchiveResult({
        account_id: T,
        archived: true,
        active_account_id: H,
        active_role: 'owner',
        moved: 5,
        invitations_revoked: 2,
      })
    ).toEqual({
      accountId: T,
      archived: true,
      activeAccountId: H,
      activeRole: 'owner',
      moved: 5,
      invitationsRevoked: 2,
    });
  });

  it('keeps a missing active row or an unknown role as null', () => {
    expect(
      parseArchiveResult({
        account_id: T,
        archived: false,
        active_account_id: null,
        active_role: 'superuser',
        moved: 0,
        invitations_revoked: 0,
      })
    ).toMatchObject({ activeAccountId: null, activeRole: null });
  });

  it('refuses anything that is not that object', () => {
    expect(parseArchiveResult(null)).toBeNull();
    expect(parseArchiveResult([])).toBeNull();
    expect(parseArchiveResult(T)).toBeNull();
    expect(
      parseArchiveResult({
        account_id: T,
        archived: 'yes',
        moved: 0,
        invitations_revoked: 0,
      })
    ).toBeNull();
    expect(
      parseArchiveResult({
        account_id: T,
        archived: true,
        moved: -1,
        invitations_revoked: 0,
      })
    ).toBeNull();
  });
});

describe('archiveErrorResponse', () => {
  it('answers 403 for a caller who is not a live owner there', () => {
    expect(
      archiveErrorResponse(
        { code: '42501', message: 'whatever the DB says' },
        true
      )
    ).toEqual({
      status: 403,
      body: { error: NOT_AN_OWNER, code: 'forbidden' },
    });
  });

  it('names each refusal with its own code', () => {
    expect(archiveErrorResponse({ code: 'WS001' }, true)).toEqual({
      status: 409,
      body: {
        error:
          'You have no other workspace to move to. Create or join another workspace first.',
        code: 'no_other_workspace',
      },
    });
    expect(archiveErrorResponse({ code: 'WS002' }, true)).toEqual({
      status: 409,
      body: {
        error:
          'This workspace still has a WhatsApp number or phone system connected. Disconnect its numbers first.',
        code: 'channels_connected',
      },
    });
    // Another workspace's phone system routing calls here: the RPC names
    // what to remove, so its message is the error.
    const routed =
      "Another workspace's phone system still sends calls here (numbers 97143105001; extensions 1051); remove them in its phone settings first";
    expect(
      archiveErrorResponse(
        { code: 'WS002', message: routed, details: 'routed_here' },
        true
      )
    ).toEqual({
      status: 409,
      body: { error: `${routed}.`, code: 'calls_routed_here' },
    });
  });

  it('counts the stranded members from the DETAIL, else the message', () => {
    expect(
      archiveErrorResponse(
        { code: 'WS003', details: '3', message: 'ignored' },
        true
      )
    ).toEqual({
      status: 409,
      body: {
        error:
          '3 members have no other workspace to move to. Deactivate or remove them first.',
        code: 'members_stranded',
        count: 3,
      },
    });
    expect(
      archiveErrorResponse(
        {
          code: 'WS003',
          details: null,
          message: '1 member(s) have no other workspace to move to',
        },
        true
      ).body
    ).toMatchObject({
      error:
        '1 member has no other workspace to move to. Deactivate or remove them first.',
      count: 1,
    });
    expect(archiveErrorResponse({ code: 'WS003' }, true).body).toEqual({
      error:
        'Some members have no other workspace to move to. Deactivate or remove them first.',
      code: 'members_stranded',
    });
  });

  it('keeps anything else generic, worded for the action', () => {
    expect(
      archiveErrorResponse({ code: 'XX000', message: 'internal detail' }, true)
    ).toEqual({
      status: 500,
      body: { error: 'Could not archive the workspace' },
    });
    expect(archiveErrorResponse({ code: null }, false)).toEqual({
      status: 500,
      body: { error: 'Could not restore the workspace' },
    });
  });
});
