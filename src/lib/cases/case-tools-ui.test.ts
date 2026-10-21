import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';

import {
  insertMention,
  isTaskOverdue,
  renderMentions,
  sortTasks,
  toolErrorKey,
  validFileRef,
} from './case-tools-ui';

const NOW = new Date('2026-10-19T10:00:00Z');
const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('isTaskOverdue', () => {
  const past = '2026-10-19T09:59:00Z';
  const future = '2026-10-19T10:01:00Z';
  it('is overdue when due before now and not done', () => {
    expect(isTaskOverdue({ dueAt: past, status: 'open' }, NOW)).toBe(true);
  });
  it('counts a blocked task', () => {
    expect(isTaskOverdue({ dueAt: past, status: 'blocked' }, NOW)).toBe(true);
  });
  it('never flags a done task, a future one or one with no due time', () => {
    expect(isTaskOverdue({ dueAt: past, status: 'done' }, NOW)).toBe(false);
    expect(isTaskOverdue({ dueAt: future, status: 'open' }, NOW)).toBe(false);
    expect(isTaskOverdue({ dueAt: null, status: 'open' }, NOW)).toBe(false);
    expect(isTaskOverdue({ dueAt: 'nope', status: 'open' }, NOW)).toBe(false);
  });
  it('takes epoch milliseconds too', () => {
    expect(isTaskOverdue({ dueAt: past, status: 'open' }, NOW.getTime())).toBe(
      true
    );
  });
});

describe('sortTasks', () => {
  it('orders by due time, undated last, then newest first', () => {
    const rows = [
      { id: 'none-old', dueAt: null, createdAt: '2026-10-01T00:00:00Z' },
      { id: 'late', dueAt: '2026-10-21T00:00:00Z', createdAt: 'x' },
      { id: 'none-new', dueAt: null, createdAt: '2026-10-02T00:00:00Z' },
      { id: 'soon', dueAt: '2026-10-20T00:00:00Z', createdAt: 'x' },
    ];
    expect(sortTasks(rows).map((r) => r.id)).toEqual([
      'soon',
      'late',
      'none-new',
      'none-old',
    ]);
  });
});

describe('renderMentions', () => {
  const nameOf = (id: string) => (id === A ? 'Sara' : null);
  it('splits text and mentions, naming known people', () => {
    expect(renderMentions(`Hi @${A}, ask @${B}.`, nameOf)).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', userId: A, name: 'Sara' },
      { kind: 'text', text: ', ask ' },
      { kind: 'mention', userId: B, name: null },
      { kind: 'text', text: '.' },
    ]);
  });
  it('canonicalises an upper-case handle and leaves other @s as text', () => {
    expect(renderMentions(`@${A.toUpperCase()} mail a@b.c`, nameOf)).toEqual([
      { kind: 'mention', userId: A, name: 'Sara' },
      { kind: 'text', text: ' mail a@b.c' },
    ]);
  });
  it('keeps markup as plain text', () => {
    expect(renderMentions('<b>x</b>', nameOf)).toEqual([
      { kind: 'text', text: '<b>x</b>' },
    ]);
    expect(renderMentions('', nameOf)).toEqual([]);
  });
});

describe('insertMention', () => {
  it('consumes the @ that opened the picker', () => {
    expect(insertMention('Hi @', 4, A)).toEqual({
      body: `Hi @${A} `,
      cursor: `Hi @${A} `.length,
    });
  });
  it('separates the handle from the previous word and the next', () => {
    const r = insertMention('askthen', 3, A);
    expect(r.body).toBe(`ask @${A} then`);
    expect(r.body.slice(0, r.cursor)).toBe(`ask @${A} `);
  });
  it('clamps the cursor and lower-cases the id', () => {
    expect(insertMention('', 99, A.toUpperCase()).body).toBe(`@${A} `);
    expect(insertMention('x', -5, A).body).toBe(`@${A} x`);
  });
});

describe('validFileRef', () => {
  it('accepts submission-app ids', () => {
    for (const ok of [
      'doc_123',
      'sub:42:passport.pdf',
      'A-b.c',
      'x'.repeat(128),
    ])
      expect(validFileRef(ok), ok).toBe(true);
  });
  it('refuses empty, dot-first, too long and other characters', () => {
    for (const bad of ['', '.hidden', 'x'.repeat(129), 'a b', 'a/b', 'é'])
      expect(validFileRef(bad), bad).toBe(false);
  });
});

describe('toolErrorKey', () => {
  const has = (key: string) =>
    key
      .split('.')
      .reduce<unknown>(
        (node, k) => (node as Record<string, unknown> | undefined)?.[k],
        en.CasePage
      ) !== undefined;

  it('names every 422 code the tool routes answer', () => {
    const codes = [
      'OWNER_INVALID',
      'DUE_INVALID',
      'TEMPLATE_NOT_FOUND',
      'FILE_REF_REQUIRED',
      'FILE_REF_INVALID',
      'DOC_NOT_REQUIRED',
      'NOTE_EMPTY',
      'NOTE_TOO_LONG',
      'CONTACT_INCOMPLETE',
      'TEXT_TOO_LONG',
    ];
    for (const code of codes) {
      const key = toolErrorKey(422, code);
      expect(key, code).not.toBe('errors.unknown');
      expect(has(key), key).toBe(true);
    }
    expect(toolErrorKey(422, 'OWNER_INVALID')).toBe(
      'tasks.errors.ownerInvalid'
    );
  });
  it('names the Compass lock (134) on a 409', () => {
    const key = toolErrorKey(409, 'MANAGED_EXTERNALLY');
    expect(key).toBe('errors.managedExternally');
    expect(has(key), key).toBe(true);
  });
  it('falls back on the status', () => {
    expect(toolErrorKey(403, undefined)).toBe('errors.notAllowed');
    expect(toolErrorKey(404, 'X')).toBe('errors.notFound');
    expect(toolErrorKey(500, null)).toBe('errors.unknown');
    expect(has('errors.unknown')).toBe(true);
  });
});
