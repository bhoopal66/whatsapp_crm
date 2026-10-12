import { describe, expect, it, vi } from 'vitest';

import {
  isTaskId,
  parseCreateTaskBody,
  parseTaskListQuery,
  parseTaskPatch,
  taskDbErrorResponse,
} from './requests';

const CALLER = '11111111-1111-4111-8111-111111111111';
const ID = '6f1c2a3b-1d2e-4f50-8a9b-0c1d2e3f4a5b';

describe('isTaskId', () => {
  it('accepts a UUID and nothing else', () => {
    expect(isTaskId(ID)).toBe(true);
    expect(isTaskId(ID.toUpperCase())).toBe(true);
    expect(isTaskId('task-1')).toBe(false);
    expect(isTaskId(`${ID}x`)).toBe(false);
  });
});

describe('parseCreateTaskBody', () => {
  it('fills the defaults and assigns the caller when assignedTo is absent', () => {
    expect(parseCreateTaskBody({ title: '  Call back  ' }, CALLER)).toEqual({
      ok: true,
      values: {
        title: 'Call back',
        note: null,
        kind: 'manual',
        source: 'manual',
        contact_id: null,
        conversation_id: null,
        deal_id: null,
        assigned_to: CALLER,
        due_at: null,
      },
    });
  });

  it('leaves the task unassigned when assignedTo is null', () => {
    const parsed = parseCreateTaskBody(
      { title: 'x', assignedTo: null },
      CALLER
    );
    expect(parsed.ok && parsed.values.assigned_to).toBeNull();
  });

  it('takes every field, normalising the due date to UTC', () => {
    const parsed = parseCreateTaskBody(
      {
        title: 'Follow up',
        note: '  bring the offer  ',
        kind: 'follow_up',
        source: 'chat',
        contactId: ID,
        conversationId: ID,
        dealId: ID,
        assignedTo: ID,
        dueAt: '2026-10-12T13:00:00+04:00',
        unknown: 'ignored',
      },
      CALLER
    );
    expect(parsed).toEqual({
      ok: true,
      values: {
        title: 'Follow up',
        note: 'bring the offer',
        kind: 'follow_up',
        source: 'chat',
        contact_id: ID,
        conversation_id: ID,
        deal_id: ID,
        assigned_to: ID,
        due_at: '2026-10-12T09:00:00.000Z',
      },
    });
  });

  it.each([
    [null, 'Invalid request body'],
    [[], 'Invalid request body'],
    [{}, 'title must be a string'],
    [{ title: '   ' }, 'title cannot be empty'],
    [{ title: 'a'.repeat(301) }, 'title must be at most 300 characters'],
    [
      { title: 'x', note: 'n'.repeat(4001) },
      'note must be at most 4000 characters',
    ],
    [{ title: 'x', note: 5 }, 'note must be a string or null'],
    [{ title: 'x', kind: 'chore' }, 'kind must be one of'],
    [{ title: 'x', source: 'pbx' }, 'source must be one of manual, chat'],
    [{ title: 'x', contactId: 'abc' }, 'contactId must be an id or null'],
    [{ title: 'x', assignedTo: '' }, 'assignedTo must be an id or null'],
    [{ title: 'x', dueAt: 'tomorrow' }, 'dueAt must be an ISO 8601 date-time'],
    [
      { title: 'x', dueAt: '2026-10-12T09:00:00' },
      'dueAt must be an ISO 8601 date-time',
    ],
    [
      { title: 'x', dueAt: '2026-10-12' },
      'dueAt must be an ISO 8601 date-time',
    ],
    [
      { title: 'x', dueAt: '2026-13-01T09:00:00Z' },
      'dueAt must be an ISO 8601 date-time',
    ],
  ])('refuses %j', (body, error) => {
    const parsed = parseCreateTaskBody(body, CALLER);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain(error);
  });

  it('counts characters, not UTF-16 units, against the limits', () => {
    const parsed = parseCreateTaskBody({ title: '😀'.repeat(300) }, CALLER);
    expect(parsed.ok).toBe(true);
  });
});

describe('parseTaskPatch', () => {
  it('maps each field to its column', () => {
    expect(
      parseTaskPatch({
        status: 'done',
        title: ' New ',
        note: ' ',
        assignedTo: null,
        dueAt: '2026-10-12T09:00Z',
        other: 1,
      })
    ).toEqual({
      ok: true,
      values: {
        status: 'done',
        title: 'New',
        note: null,
        assigned_to: null,
        due_at: '2026-10-12T09:00:00.000Z',
      },
    });
  });

  it('sets only the keys sent', () => {
    expect(parseTaskPatch({ assignedTo: ID })).toEqual({
      ok: true,
      values: { assigned_to: ID },
    });
  });

  it.each([
    [{}, 'Nothing to update'],
    [{ other: 1 }, 'Nothing to update'],
    ['done', 'Invalid request body'],
    [{ status: 'closed' }, 'status must be one of open, done, cancelled'],
    [{ title: '' }, 'title cannot be empty'],
    [{ dueAt: 'soon' }, 'dueAt must be'],
  ])('refuses %j', (body, error) => {
    const parsed = parseTaskPatch(body);
    expect(!parsed.ok && parsed.error).toContain(error);
  });
});

describe('parseTaskListQuery', () => {
  const parse = (qs: string) => parseTaskListQuery(new URLSearchParams(qs));

  it('defaults to my open tasks, 100 of them', () => {
    expect(parse('')).toEqual({
      ok: true,
      query: { scope: 'mine', status: 'open', limit: 100 },
    });
  });

  it('reads each scope with the id it needs', () => {
    expect(parse(`scope=contact&contactId=${ID}&status=all&limit=20`)).toEqual({
      ok: true,
      query: { scope: 'contact', contactId: ID, status: 'all', limit: 20 },
    });
    expect(
      parse(`scope=conversation&conversationId=${ID}&status=done`)
    ).toEqual({
      ok: true,
      query: {
        scope: 'conversation',
        conversationId: ID,
        status: 'done',
        limit: 100,
      },
    });
    expect(parse('scope=all&limit=200')).toEqual({
      ok: true,
      query: { scope: 'all', status: 'open', limit: 200 },
    });
  });

  it.each([
    ['scope=team', 'scope must be one of'],
    ['scope=contact', 'contactId must be an id'],
    ['scope=contact&contactId=abc', 'contactId must be an id'],
    ['scope=conversation', 'conversationId must be an id'],
    ['status=late', 'status must be one of open, done, cancelled, all'],
    ['limit=0', 'limit must be a whole number from 1 to 200'],
    ['limit=201', 'limit must be a whole number from 1 to 200'],
    ['limit=1.5', 'limit must be a whole number from 1 to 200'],
    ['limit=ten', 'limit must be a whole number from 1 to 200'],
  ])('refuses ?%s', (qs, error) => {
    const parsed = parse(qs);
    expect(!parsed.ok && parsed.error).toContain(error);
  });
});

describe('taskDbErrorResponse', () => {
  it.each([
    ['42501', 403, "You can't make that change to this task"],
    ['23514', 400, 'Assignee must be an active agent of this account'],
    [
      '23503',
      400,
      'A linked contact, conversation, deal or person was not found',
    ],
    ['22P02', 400, 'Invalid value'],
    ['22007', 400, 'Invalid value'],
    ['22008', 400, 'Invalid value'],
    ['23505', 409, 'That task already exists'],
  ])('maps %s to %i', async (code, status, error) => {
    const res = taskDbErrorResponse(
      { code, message: 'Assignee must be an active agent of this account' },
      'Failed to save task'
    );
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('logs anything else and answers the fallback, not the raw error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = taskDbErrorResponse(
      {
        code: '57014',
        message: 'canceling statement due to statement timeout',
      },
      'Failed to save task'
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save task' });
    expect(log).toHaveBeenCalled();
  });
});
