import { describe, expect, it } from 'vitest';

import {
  inDepartmentInbox,
  inDepartmentView,
  inMainInbox,
  mainInboxGroup,
  viewerInboxDepartment,
} from './departments';
import { admitsInsertedConversation, inPersonalInbox } from './insights';
import { countDepartmentUnread, countUnreadChats } from './unread-counts';

const hr = {
  inbox_department: 'hr',
  user_id: 'owner',
  assigned_agent_id: 'held',
};

describe('inMainInbox (migration 192)', () => {
  it('lists every chat with no department', () => {
    expect(inMainInbox({ inbox_department: null }, 'me')).toBe(true);
    expect(inMainInbox({}, 'me')).toBe(true);
  });

  it("leaves someone else's department chat out", () => {
    expect(inMainInbox(hr, 'me')).toBe(false);
  });

  it('keeps a department chat its owner or assignee works', () => {
    expect(inMainInbox(hr, 'owner')).toBe(true);
    expect(inMainInbox(hr, 'held')).toBe(true);
  });

  it('fails closed while the viewer is unknown', () => {
    expect(inMainInbox(hr, null)).toBe(false);
    expect(inMainInbox({ inbox_department: null }, null)).toBe(true);
    expect(inMainInbox(hr, null, 'hr')).toBe(false);
  });

  it("keeps a colleague's chat of the viewer's own department", () => {
    expect(inMainInbox(hr, 'me', 'hr')).toBe(true);
    expect(inMainInbox(hr, 'me', 'it')).toBe(false);
    expect(inMainInbox(hr, 'me', null)).toBe(false);
  });
});

describe('viewerInboxDepartment', () => {
  it("is a non-admin's own department inbox", () => {
    expect(viewerInboxDepartment('team_leader', 'hr')).toBe('hr');
    expect(viewerInboxDepartment('agent', 'it')).toBe('it');
    expect(viewerInboxDepartment('viewer', 'accounts')).toBe('accounts');
  });

  it('is none for sales, admins, unknown values or no role', () => {
    expect(viewerInboxDepartment('team_leader', 'sales')).toBeNull();
    expect(viewerInboxDepartment('admin', 'hr')).toBeNull();
    expect(viewerInboxDepartment('owner', 'hr')).toBeNull();
    expect(viewerInboxDepartment('team_leader', 'legal')).toBeNull();
    expect(viewerInboxDepartment('team_leader', null)).toBeNull();
    expect(viewerInboxDepartment(null, 'hr')).toBeNull();
  });
});

describe('inDepartmentInbox', () => {
  it("lists only that department's chats", () => {
    expect(inDepartmentInbox(hr, 'hr')).toBe(true);
    expect(inDepartmentInbox(hr, 'it')).toBe(false);
    expect(inDepartmentInbox({ inbox_department: null }, 'hr')).toBe(false);
  });
});

describe('inDepartmentView', () => {
  it('picks the rule the view names', () => {
    expect(inDepartmentView(hr, { department: 'hr' })).toBe(true);
    expect(inDepartmentView(hr, { mainFor: 'me' })).toBe(false);
    expect(inDepartmentView(hr, { mainFor: 'owner' })).toBe(true);
    expect(inDepartmentView(hr, { mainFor: 'me', ownDepartment: 'hr' })).toBe(
      true
    );
  });
});

describe('mainInboxGroup', () => {
  it('asks for main chats and my own department chats', () => {
    expect(mainInboxGroup('u1')).toBe(
      'inbox_department.is.null,user_id.eq.u1,assigned_agent_id.eq.u1'
    );
  });

  it("adds the viewer's own department when there is one", () => {
    expect(mainInboxGroup('u1', 'hr')).toBe(
      'inbox_department.is.null,user_id.eq.u1,assigned_agent_id.eq.u1,inbox_department.eq.hr'
    );
    expect(mainInboxGroup('u1', null)).toBe(mainInboxGroup('u1'));
  });
});

describe('realtime admission by department', () => {
  const row = { id: 'c1', ...hr };

  it("keeps someone else's HR chat out of the main inboxes", () => {
    expect(
      admitsInsertedConversation(row, new Set(), null, undefined, {
        mainFor: 'me',
      })
    ).toBe(false);
    expect(inPersonalInbox(row, null, undefined, { mainFor: 'me' })).toBe(
      false
    );
  });

  it("admits it to its owner's Inbox and to the HR inbox", () => {
    expect(
      admitsInsertedConversation(row, new Set(), null, 'owner', {
        mainFor: 'owner',
      })
    ).toBe(true);
    expect(
      admitsInsertedConversation(row, new Set(), null, undefined, {
        department: 'hr',
      })
    ).toBe(true);
  });

  it('keeps a main chat out of the HR inbox', () => {
    expect(
      inPersonalInbox({ id: 'c2', inbox_department: null }, null, undefined, {
        department: 'hr',
      })
    ).toBe(false);
  });
});

describe('unread counts by department', () => {
  const rows = [
    { id: 'a', unread_count: 1 },
    { id: 'b', unread_count: 2, ...hr },
    { id: 'c', unread_count: 1, inbox_department: 'it', user_id: 'x' },
    { id: 'd', unread_count: 0, ...hr },
  ];

  it('counts department chats in neither main inbox but the owner’s', () => {
    expect(countUnreadChats(rows, false, null, 'me')).toEqual({
      inbox: 1,
      team: 1,
    });
    expect(countUnreadChats(rows, false, null, 'owner')).toEqual({
      inbox: 2,
      team: 2,
    });
  });

  it("counts the viewer's own department's chats for a team leader", () => {
    expect(countUnreadChats(rows, false, null, 'me', 'hr').team).toBe(
      countUnreadChats(rows, false, null, 'me').team + 1
    );
  });

  it('counts the HR inbox on its own', () => {
    expect(countDepartmentUnread(rows, false, 'hr')).toBe(1);
    expect(countDepartmentUnread(rows, false, 'it')).toBe(1);
    expect(countDepartmentUnread(rows, false, 'accounts')).toBe(0);
  });
});
