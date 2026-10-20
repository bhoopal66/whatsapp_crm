import { describe, expect, it } from 'vitest';

import {
  canAssignToOthers,
  canReadContact,
  canViewContact,
  canViewConversation,
  viewsOthersConversations,
} from './conversation-visibility';

// This mirrors the `can_view_conversation` SQL function from migration
// 042. The database is the enforcement point — the browser queries
// PostgREST directly, so a check in the UI is advisory. These cases
// exist so the RULE is pinned down in one readable place, and so the
// TypeScript helper the UI uses for labels and affordances cannot
// drift away from what the database will actually return.

const ACCOUNT = 'acct-1';
const ME = 'user-me';
const COLLEAGUE = 'user-them';

describe('canViewConversation', () => {
  it('does not grant a colleague’s chat for allocation to its number (migration 072)', () => {
    // Allocation decides where someone may send from, not what they
    // see. The mirror no longer takes the flag; a stale caller passing
    // it (built via a variable to dodge the excess-property check)
    // must still get "no".
    const stale = {
      ownerId: COLLEAGUE,
      assignedId: null,
      onAllocatedNumber: true,
    };
    expect(canViewConversation('agent', ME, stale)).toBe(false);
    expect(canViewConversation('team_leader', ME, stale)).toBe(false);
  });

  it('shows admins and owners every conversation in the account', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(
        canViewConversation(role, ME, { ownerId: COLLEAGUE, assignedId: null })
      ).toBe(true);
    }
  });

  it('shows a member the conversations they created', () => {
    expect(
      canViewConversation('agent', ME, { ownerId: ME, assignedId: null })
    ).toBe(true);
  });

  it('shows a member the conversations assigned to them', () => {
    // The admin triage path: a chat someone else started, handed over.
    expect(
      canViewConversation('agent', ME, { ownerId: COLLEAGUE, assignedId: ME })
    ).toBe(true);
  });

  it('hides a colleague’s conversation from an agent', () => {
    expect(
      canViewConversation('agent', ME, { ownerId: COLLEAGUE, assignedId: null })
    ).toBe(false);
  });

  it('hides a conversation assigned away from its own creator', () => {
    // Ownership is not sticky: `user_id` still points at the creator,
    // but an explicit assignment to someone else does NOT revoke the
    // creator's access — they keep it. This documents that choice.
    expect(
      canViewConversation('agent', ME, { ownerId: ME, assignedId: COLLEAGUE })
    ).toBe(true);
  });

  it('treats viewers exactly like agents for visibility', () => {
    expect(
      canViewConversation('viewer', ME, { ownerId: ME, assignedId: null })
    ).toBe(true);
    expect(
      canViewConversation('viewer', ME, {
        ownerId: COLLEAGUE,
        assignedId: null,
      })
    ).toBe(false);
  });

  it('fails closed when the role or user is unknown', () => {
    // Role still loading, or a profile that never resolved. Showing a
    // chat and then hiding it is worse than a brief empty list.
    expect(
      canViewConversation(null, ME, { ownerId: ME, assignedId: null })
    ).toBe(false);
    expect(
      canViewConversation('agent', null, { ownerId: ME, assignedId: null })
    ).toBe(false);
  });
});

describe('canAssignToOthers', () => {
  it('is an admin-only power', () => {
    expect(canAssignToOthers('owner')).toBe(true);
    expect(canAssignToOthers('admin')).toBe(true);
    expect(canAssignToOthers('agent')).toBe(false);
    expect(canAssignToOthers('viewer')).toBe(false);
    expect(canAssignToOthers(null)).toBe(false);
  });
});

// Keeps the unused-import lint quiet about ACCOUNT while documenting
// that visibility is always evaluated within a single account — the
// account check happens in `is_account_member` on the SQL side.
export { ACCOUNT };

describe('canViewContact', () => {
  it('shows admins every contact', () => {
    expect(
      canViewContact('admin', ME, { creatorId: COLLEAGUE, handlesChat: false })
    ).toBe(true);
  });

  it('shows a member the contacts they created, chat or not', () => {
    // The "add a contact, then message them" path: visible before any
    // conversation exists.
    expect(
      canViewContact('agent', ME, { creatorId: ME, handlesChat: false })
    ).toBe(true);
  });

  it('shows a member a colleague’s contact once they handle the chat', () => {
    // This is what makes admin triage work in one step: assigning the
    // conversation hands over the customer record with it.
    expect(
      canViewContact('agent', ME, { creatorId: COLLEAGUE, handlesChat: true })
    ).toBe(true);
  });

  it('hides a colleague’s contact with no chat of ours', () => {
    expect(
      canViewContact('agent', ME, { creatorId: COLLEAGUE, handlesChat: false })
    ).toBe(false);
    // Absent flag must read as "no", not "unknown, allow".
    expect(canViewContact('agent', ME, { creatorId: COLLEAGUE })).toBe(false);
  });

  it('fails closed on an unresolved role or user', () => {
    expect(canViewContact(null, ME, { creatorId: ME })).toBe(false);
    expect(canViewContact('agent', null, { creatorId: ME })).toBe(false);
  });
});

// Migration 133: a chat shared with a coordinator. The share grants the
// chat (read and reply) and its contact read-only, to a live agent or
// team leader only (`coordinator_share_grants`).
describe('a chat shared with me (migration 133)', () => {
  const colleagues = { ownerId: COLLEAGUE, assignedId: null };

  it('shows a colleague’s shared chat to an agent or team leader', () => {
    for (const role of ['agent', 'team_leader'] as const) {
      expect(
        canViewConversation(role, ME, { ...colleagues, sharedWithMe: true })
      ).toBe(true);
      expect(
        canViewConversation(role, ME, { ...colleagues, sharedWithMe: false })
      ).toBe(false);
    }
  });

  it('grants nothing to a viewer or a bank guest, as the SQL role check', () => {
    for (const role of ['viewer', 'bank_guest'] as const) {
      expect(
        canViewConversation(role, ME, { ...colleagues, sharedWithMe: true })
      ).toBe(false);
    }
  });

  it('fails closed on an unresolved role or user, share or not', () => {
    const shared = { ...colleagues, sharedWithMe: true };
    expect(canViewConversation(null, ME, shared)).toBe(false);
    expect(canViewConversation('agent', null, shared)).toBe(false);
  });

  it('lets the coordinator read the contact', () => {
    for (const role of ['agent', 'team_leader'] as const) {
      expect(
        canReadContact(role, ME, { creatorId: COLLEAGUE, sharedWithMe: true })
      ).toBe(true);
    }
    expect(
      canReadContact('viewer', ME, { creatorId: COLLEAGUE, sharedWithMe: true })
    ).toBe(false);
    expect(
      canReadContact(null, ME, { creatorId: COLLEAGUE, sharedWithMe: true })
    ).toBe(false);
  });

  it('does not make the contact editable (can_view_contact is unchanged)', () => {
    // canViewContact is the mirror of can_view_contact, which gates
    // contact edit and delete; a share must not reach it. Passed via a
    // variable to dodge the excess-property check, like a stale caller.
    const shared = { creatorId: COLLEAGUE, sharedWithMe: true };
    expect(canViewContact('agent', ME, shared)).toBe(false);
    expect(canViewContact('team_leader', ME, shared)).toBe(false);
  });

  it('reads the contact exactly as canViewContact without a share', () => {
    expect(canReadContact('agent', ME, { creatorId: ME })).toBe(true);
    expect(
      canReadContact('agent', ME, { creatorId: COLLEAGUE, handlesChat: true })
    ).toBe(true);
    expect(canReadContact('admin', ME, { creatorId: COLLEAGUE })).toBe(true);
    expect(canReadContact('agent', ME, { creatorId: COLLEAGUE })).toBe(false);
  });
});

describe('team_leader in the role ladder', () => {
  it('sits between agent and admin', async () => {
    const { roleRank, hasMinRole } = await import('./roles');
    expect(roleRank('team_leader')).toBeGreaterThan(roleRank('agent'));
    expect(roleRank('team_leader')).toBeLessThan(roleRank('admin'));
    // Inherits everything an agent can do...
    expect(hasMinRole('team_leader', 'agent')).toBe(true);
    // ...and none of what an admin can.
    expect(hasMinRole('team_leader', 'admin')).toBe(false);
  });

  it('cannot assign outside its team, and is not an admin', async () => {
    // `canAssignToOthers` describes the unrestricted power. A leader's
    // narrower "within my team" case is decided by the database
    // (migration 044) plus the team membership the UI loads.
    expect(canAssignToOthers('team_leader')).toBe(false);
  });

  it('gets the team views but not the admin screens', async () => {
    const { canLeadTeam, canManageTeams, canEditSettings } =
      await import('./roles');
    expect(canLeadTeam('team_leader')).toBe(true);
    expect(canLeadTeam('agent')).toBe(false);
    // Admins outrank leaders, so they see the team views too.
    expect(canLeadTeam('admin')).toBe(true);
    // But a leader configures nothing account-wide.
    expect(canManageTeams('team_leader')).toBe(false);
    expect(canEditSettings('team_leader')).toBe(false);
  });

  it('sees a conversation belonging to nobody it knows as hidden', () => {
    // The team half of the rule lives in SQL (`leads_teammate`); this
    // helper only knows about own/assigned, so a leader must NOT be
    // silently treated as an admin here.
    expect(
      canViewConversation('team_leader', ME, {
        ownerId: COLLEAGUE,
        assignedId: null,
      })
    ).toBe(false);
  });
});

describe('viewsOthersConversations', () => {
  it('is off for an agent allocated to a number — no shared inbox since 072', () => {
    const stale = viewsOthersConversations as (...a: unknown[]) => boolean;
    expect(stale('agent', false, true)).toBe(false);
    expect(stale('team_leader', false, true)).toBe(false);
  });

  it('is on for admins and owners on both inbox routes', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(viewsOthersConversations(role, false)).toBe(true);
      expect(viewsOthersConversations(role, true)).toBe(true);
    }
  });

  it('is on for a team leader only in the team view', () => {
    // /inbox narrows a leader back to their own threads, so every row
    // there is already theirs — naming the holder would be noise.
    expect(viewsOthersConversations('team_leader', false)).toBe(false);
    expect(viewsOthersConversations('team_leader', true)).toBe(true);
  });

  it('is off for members, who only ever see their own chats', () => {
    for (const role of ['agent', 'viewer'] as const) {
      expect(viewsOthersConversations(role, false)).toBe(false);
      expect(viewsOthersConversations(role, true)).toBe(false);
    }
  });

  it('fails closed while the profile is still resolving', () => {
    expect(viewsOthersConversations(null, true)).toBe(false);
  });
});
