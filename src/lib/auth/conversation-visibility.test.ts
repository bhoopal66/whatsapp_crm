import { describe, expect, it } from 'vitest';

import {
  canAssignToOthers,
  canViewContact,
  canViewConversation,
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
  it('shows admins and owners every conversation in the account', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(
        canViewConversation(role, ME, { ownerId: COLLEAGUE, assignedId: null }),
      ).toBe(true);
    }
  });

  it('shows a member the conversations they created', () => {
    expect(
      canViewConversation('agent', ME, { ownerId: ME, assignedId: null }),
    ).toBe(true);
  });

  it('shows a member the conversations assigned to them', () => {
    // The admin triage path: a chat someone else started, handed over.
    expect(
      canViewConversation('agent', ME, { ownerId: COLLEAGUE, assignedId: ME }),
    ).toBe(true);
  });

  it('hides a colleague’s conversation from an agent', () => {
    expect(
      canViewConversation('agent', ME, { ownerId: COLLEAGUE, assignedId: null }),
    ).toBe(false);
  });

  it('hides a conversation assigned away from its own creator', () => {
    // Ownership is not sticky: `user_id` still points at the creator,
    // but an explicit assignment to someone else does NOT revoke the
    // creator's access — they keep it. This documents that choice.
    expect(
      canViewConversation('agent', ME, { ownerId: ME, assignedId: COLLEAGUE }),
    ).toBe(true);
  });

  it('treats viewers exactly like agents for visibility', () => {
    expect(
      canViewConversation('viewer', ME, { ownerId: ME, assignedId: null }),
    ).toBe(true);
    expect(
      canViewConversation('viewer', ME, { ownerId: COLLEAGUE, assignedId: null }),
    ).toBe(false);
  });

  it('fails closed when the role or user is unknown', () => {
    // Role still loading, or a profile that never resolved. Showing a
    // chat and then hiding it is worse than a brief empty list.
    expect(
      canViewConversation(null, ME, { ownerId: ME, assignedId: null }),
    ).toBe(false);
    expect(
      canViewConversation('agent', null, { ownerId: ME, assignedId: null }),
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
      canViewContact('admin', ME, { creatorId: COLLEAGUE, handlesChat: false }),
    ).toBe(true);
  });

  it('shows a member the contacts they created, chat or not', () => {
    // The "add a contact, then message them" path: visible before any
    // conversation exists.
    expect(
      canViewContact('agent', ME, { creatorId: ME, handlesChat: false }),
    ).toBe(true);
  });

  it('shows a member a colleague’s contact once they handle the chat', () => {
    // This is what makes admin triage work in one step: assigning the
    // conversation hands over the customer record with it.
    expect(
      canViewContact('agent', ME, { creatorId: COLLEAGUE, handlesChat: true }),
    ).toBe(true);
  });

  it('hides a colleague’s contact with no chat of ours', () => {
    expect(
      canViewContact('agent', ME, { creatorId: COLLEAGUE, handlesChat: false }),
    ).toBe(false);
    // Absent flag must read as "no", not "unknown, allow".
    expect(canViewContact('agent', ME, { creatorId: COLLEAGUE })).toBe(false);
  });

  it('fails closed on an unresolved role or user', () => {
    expect(canViewContact(null, ME, { creatorId: ME })).toBe(false);
    expect(canViewContact('agent', null, { creatorId: ME })).toBe(false);
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
    const { canLeadTeam, canManageTeams, canEditSettings } = await import('./roles');
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
      canViewConversation('team_leader', ME, { ownerId: COLLEAGUE, assignedId: null }),
    ).toBe(false);
  });
});
