// The case server factories: each builds its store on the service-role
// client (mocked here; no network) and returns an instance.
import { describe, expect, it, vi } from 'vitest';

const admin = vi.hoisted(() => ({ rpc: () => null, from: () => null }));
vi.mock('@/lib/submission-groups/server', () => ({
  supabaseAdmin: vi.fn(() => admin),
  submissionGroupService: vi.fn(() => ({ endNow: vi.fn() })),
}));

import {
  submissionGroupService,
  supabaseAdmin,
} from '@/lib/submission-groups/server';

import { CaseBankContactsStore } from './bank-contacts';
import { BankWorkspaceStore } from './bank-workspaces';
import { CaseConversations } from './conversations';
import { BankDashboard } from './dashboard';
import { CaseInbox } from './inbox';
import { CaseNotesStore } from './notes';
import {
  bankDashboard,
  bankWorkspaceStore,
  caseBankContactsStore,
  caseConversations,
  caseInbox,
  caseNotesStore,
  caseSlaStore,
  caseStore,
  caseToolsStore,
} from './server';
import { CaseSlaStore } from './sla';
import { CaseStore } from './store';
import { CaseToolsStore } from './tools';

const ACCOUNT = '44444444-4444-4444-8444-444444444444';

describe('case server factories', () => {
  it.each([
    ['caseStore', caseStore, CaseStore],
    ['caseToolsStore', caseToolsStore, CaseToolsStore],
    ['caseNotesStore', caseNotesStore, CaseNotesStore],
    ['caseBankContactsStore', caseBankContactsStore, CaseBankContactsStore],
    ['caseSlaStore', caseSlaStore, CaseSlaStore],
    ['caseInbox', caseInbox, CaseInbox],
    ['bankWorkspaceStore', bankWorkspaceStore, BankWorkspaceStore],
    ['bankDashboard', bankDashboard, BankDashboard],
  ] as const)('%s builds on supabaseAdmin()', (_n, make, Cls) => {
    vi.mocked(supabaseAdmin).mockClear();
    expect((make as () => unknown)()).toBeInstanceOf(Cls);
    expect(supabaseAdmin).toHaveBeenCalledTimes(1);
  });

  it("caseConversations(accountId) wires that account's 115 service on one client, draft not allowed", async () => {
    vi.mocked(supabaseAdmin).mockClear();
    vi.mocked(submissionGroupService).mockClear();
    const c = caseConversations(ACCOUNT);
    expect(c).toBeInstanceOf(CaseConversations);
    expect(supabaseAdmin).toHaveBeenCalledTimes(1);
    expect(submissionGroupService).toHaveBeenCalledWith(ACCOUNT, admin);
    // The DRAFT hand-over template is refused before anything is read.
    await expect(
      c.takeOver('u', 'c', { agentName: 'A', bankName: 'B' })
    ).rejects.toMatchObject({ reason: 'TEMPLATE_NOT_APPROVED' });
  });
});
