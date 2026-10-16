import { describe, expect, it } from 'vitest';

import {
  GROUP_ADD_POLICY,
  GROUP_NAME_MAX as SERVER_NAME_MAX,
} from '@/lib/whatsapp/groups';

import {
  buildCreateBody,
  contactSearchFilter,
  DEFAULT_TOGGLES,
  filterGroups,
  firstInvalidStep,
  GROUP_ADD_BATCH,
  GROUP_ADD_PAUSE_SECONDS,
  GROUP_MEMBERS_PER_OPERATION,
  GROUP_NAME_MAX,
  groupInitials,
  mergeMembers,
  parseCreateResult,
  parseGroupList,
  parsePhoneList,
  relativeActivity,
  summarizeResult,
  validateStep,
  type GroupListItem,
  type WizardValues,
} from './ui';

const values = (over: Partial<WizardValues> = {}): WizardValues => ({
  channelId: 'ch1',
  name: 'Sales leads',
  description: '',
  contacts: [],
  typedText: '+971 50 123 4567',
  toggles: DEFAULT_TOGGLES,
  managerIds: [],
  ...over,
});

describe('limits mirrored from lib/whatsapp/groups', () => {
  it('agree with the server module', () => {
    expect(GROUP_NAME_MAX).toBe(SERVER_NAME_MAX);
    expect(GROUP_ADD_BATCH).toBe(GROUP_ADD_POLICY.batchSize);
    expect(GROUP_ADD_PAUSE_SECONDS * 1000).toBe(GROUP_ADD_POLICY.pauseMs);
    expect(GROUP_MEMBERS_PER_OPERATION).toBe(GROUP_ADD_POLICY.maxPerOperation);
  });
});

describe('parsePhoneList', () => {
  it('splits on lines, commas and semicolons, validating and de-duplicating', () => {
    const out = parsePhoneList(
      '+971 50 123 4567\n971501234567, 44 20 7946 0958;\n\n hello '
    );
    expect(out.map((t) => t.waId)).toEqual([
      '971501234567',
      '442079460958',
      null,
    ]);
    expect(out[2]).toMatchObject({ input: 'hello' });
    expect(out[2].error).toBeTruthy();
  });

  it('is empty for blank input', () => {
    expect(parsePhoneList(' \n , ')).toEqual([]);
  });
});

describe('mergeMembers', () => {
  it('keeps a typed number that is also a picked contact once, as the contact', () => {
    const merged = mergeMembers(
      [
        { id: 'c1', name: 'Amina', phone: '+971501234567' },
        { id: 'c2', name: 'No phone', phone: null },
      ],
      parsePhoneList('971 50 123 4567\n442079460958\nnope')
    );
    expect(merged.members).toEqual([
      { waId: '971501234567', name: 'Amina', contactId: 'c1' },
      { waId: '442079460958', name: null, contactId: null },
    ]);
    expect(merged.unusableContacts.map((c) => c.id)).toEqual(['c2']);
    expect(merged.invalidTyped.map((t) => t.input)).toEqual(['nope']);
  });
});

describe('validateStep', () => {
  it('checks the basics', () => {
    expect(validateStep('basics', values())).toBeNull();
    expect(validateStep('basics', values({ channelId: null }))).toBe(
      'numberRequired'
    );
    expect(validateStep('basics', values({ name: '  ' }))).toBe('nameRequired');
    expect(validateStep('basics', values({ name: 'x'.repeat(101) }))).toBe(
      'nameTooLong'
    );
    // Counted by character: 100 emoji fit.
    expect(
      validateStep('basics', values({ name: '😀'.repeat(100) }))
    ).toBeNull();
  });

  it('needs at least one member and no invalid typed number', () => {
    expect(validateStep('members', values())).toBeNull();
    expect(validateStep('members', values({ typedText: '' }))).toBe(
      'membersRequired'
    );
    expect(
      validateStep('members', values({ typedText: '971501234567\n123' }))
    ).toBe('fixInvalidNumbers');
    expect(validateStep('settings', values({ typedText: '' }))).toBeNull();
  });

  it('firstInvalidStep names the earliest problem', () => {
    expect(firstInvalidStep(values({ typedText: '', name: '' }))).toEqual({
      step: 'basics',
      error: 'nameRequired',
    });
    expect(firstInvalidStep(values())).toBeNull();
  });
});

describe('buildCreateBody', () => {
  it('sends every member once, contact ids, all four settings and managers', () => {
    const body = buildCreateBody(
      values({
        name: '  Leads ',
        description: ' hi ',
        contacts: [{ id: 'c1', name: 'A', phone: '971501234567' }],
        typedText: '+971501234567\n442079460958',
        toggles: { ...DEFAULT_TOGGLES, send_messages: true },
        managerIds: ['u1', 'u1'],
      })
    );
    expect(body).toEqual({
      channelId: 'ch1',
      name: 'Leads',
      description: 'hi',
      participants: ['971501234567', '442079460958'],
      contactIds: ['c1'],
      settings: {
        send_messages: 'admins',
        edit_group_info: 'admins',
        approve_participants: 'anyone',
        add_participants: 'admins',
      },
      managerIds: ['u1'],
    });
  });

  it('leaves the optional keys out when empty', () => {
    const body = buildCreateBody(values());
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('contactIds');
    expect(body).not.toHaveProperty('managerIds');
  });
});

describe('summarizeResult', () => {
  it('names each number and counts who still needs the link', () => {
    const result = parseCreateResult({
      group: { id: 'g1' },
      added: ['1', '1'],
      refused: ['2', '1'],
      notAttempted: ['3'],
      invalid: ['abc'],
      warnings: 'x',
    });
    expect(result.groupId).toBe('g1');
    expect(result.warnings).toEqual([]);
    const s = summarizeResult(result, [
      { waId: '1', name: 'Amina', contactId: 'c1' },
    ]);
    expect(s.added).toEqual([{ waId: '1', name: 'Amina' }]);
    expect(s.refused).toEqual([{ waId: '2', name: null }]);
    expect(s.notAttempted).toEqual([{ waId: '3', name: null }]);
    expect(s.invalid).toEqual([{ waId: 'abc', name: null }]);
    expect(s.needInvite).toBe(2);
  });
});

describe('the list', () => {
  const g = (over: Partial<GroupListItem>): GroupListItem => ({
    id: 'g',
    name: 'G',
    description: null,
    icon_url: null,
    participants_count: 3,
    our_role: 'admin',
    channel_id: 'ch1',
    channel: { id: 'ch1', name: 'Sales', phone: '+971 50 000 1111' },
    last_message_at: null,
    created_by: null,
    can_manage: true,
    ...over,
  });

  it('parseGroupList drops malformed rows and defaults the rest', () => {
    expect(
      parseGroupList({
        groups: [null, { name: 'no id' }, { id: 'a', our_role: 'boss' }],
      })
    ).toEqual([
      expect.objectContaining({
        id: 'a',
        name: '',
        our_role: 'member',
        participants_count: 0,
        channel: null,
        can_manage: false,
      }),
    ]);
    expect(parseGroupList(null)).toEqual([]);
  });

  it('filterGroups searches name, number name and digits; left groups sink', () => {
    const list = [
      g({ id: 'old', name: 'Alpha', last_message_at: '2026-10-01T00:00:00Z' }),
      g({
        id: 'left',
        name: 'Beta',
        our_role: 'left',
        last_message_at: '2026-10-15T00:00:00Z',
      }),
      g({ id: 'new', name: 'Gamma', last_message_at: '2026-10-10T00:00:00Z' }),
    ];
    expect(filterGroups(list, '').map((x) => x.id)).toEqual([
      'new',
      'old',
      'left',
    ]);
    expect(filterGroups(list, 'alp').map((x) => x.id)).toEqual(['old']);
    expect(filterGroups(list, 'sales')).toHaveLength(3);
    expect(filterGroups(list, '0001111')).toHaveLength(3);
    expect(filterGroups(list, 'zzz')).toEqual([]);
  });

  it('groupInitials', () => {
    expect(groupInitials('Sales leads')).toBe('SL');
    expect(groupInitials('vip')).toBe('VI');
    expect(groupInitials('  ')).toBe('#');
    expect(groupInitials('🔥 Hot leads')).toBe('HL');
  });

  it('relativeActivity buckets', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    expect(relativeActivity(null, now)).toEqual({ unit: 'none' });
    expect(relativeActivity('2026-10-16T12:00:30Z', now)).toEqual({
      unit: 'now',
    });
    expect(relativeActivity('2026-10-16T11:55:00Z', now)).toEqual({
      unit: 'minute',
      value: 5,
    });
    expect(relativeActivity('2026-10-16T09:00:00Z', now)).toEqual({
      unit: 'hour',
      value: 3,
    });
    expect(relativeActivity('2026-10-13T12:00:00Z', now)).toEqual({
      unit: 'day',
      value: 3,
    });
    expect(relativeActivity('2026-09-01T00:00:00Z', now).unit).toBe('date');
  });

  it('contactSearchFilter strips filter syntax and adds a digits match', () => {
    expect(contactSearchFilter('a')).toBeNull();
    expect(contactSearchFilter('Ali,(x)')).toBe(
      'name.ilike.*Ali  x*,phone.ilike.*Ali  x*'
    );
    expect(contactSearchFilter('+971 50')).toBe(
      'name.ilike.*+971 50*,phone.ilike.*+971 50*,phone.ilike.*97150*'
    );
  });
});

describe('parseCreateResult with the real create-route shape', () => {
  it('shows identity objects as added, refused and not attempted', () => {
    const r = parseCreateResult({
      group: { id: '120363@g.us' },
      added: [{ jid: '971501111111@s.whatsapp.net', waId: '971501111111' }],
      refused: [{ jid: '971502222222@s.whatsapp.net', waId: null }],
      notAttempted: ['971503333333'],
      invalid: ['x'],
      skipped: [{ waId: '971504444444', contactId: 'c', reason: 'opted_out' }],
    });
    expect(r.added).toEqual(['971501111111']);
    expect(r.refused).toEqual(['971502222222']);
    expect(r.notAttempted).toEqual(['971503333333']);
    expect(r.skipped).toEqual([{ waId: '971504444444', reason: 'opted_out' }]);
  });
});
