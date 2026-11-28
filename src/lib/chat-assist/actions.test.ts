import { describe, expect, it } from 'vitest';

import {
  buildRefs,
  currentTagOrdinal,
  extractJson,
  planActions,
  type SuggestionRefs,
} from './actions';
import { CHAT_ASSIST_NOTE_MAX } from './tools';

const CHAT = '44444444-4444-4444-8444-444444444444';
const T_INT = 'a0000000-0000-4000-8000-000000000001';
const T_ADCB = 'a0000000-0000-4000-8000-000000000002';
const T_LOST = 'a0000000-0000-4000-8000-000000000003';
const T_LOST_SUB = 'a0000000-0000-4000-8000-000000000004';
const U_SARA = 'b0000000-0000-4000-8000-000000000001';
const U_OMAR = 'b0000000-0000-4000-8000-000000000002';

const built = buildRefs({
  tags: [
    { id: T_INT, name: 'Interested', parent_id: null },
    { id: T_LOST, name: 'Lost', parent_id: null },
    { id: T_ADCB, name: 'ADCB', parent_id: T_INT },
    { id: T_LOST_SUB, name: 'Price', parent_id: T_LOST },
  ],
  members: [
    { userId: U_SARA, name: 'Sara' },
    { userId: U_OMAR, name: 'Omar' },
  ],
});

const refs = (over: Partial<SuggestionRefs> = {}): SuggestionRefs => ({
  conversationId: CHAT,
  tags: built.tags,
  members: built.members,
  currentTagId: null,
  currentSubTagId: null,
  assignedTo: U_SARA,
  now: Date.UTC(2026, 10, 26, 8, 0),
  ...over,
});

const json = (actions: unknown[]) => JSON.stringify({ actions });

describe('buildRefs', () => {
  it('numbers main tags, their sub-tags and teammates', () => {
    expect(
      built.tags.map((t) => [t.ordinal, t.name, t.subs.map((s) => s.ordinal)])
    ).toEqual([
      ['T1', 'Interested', ['T1.1']],
      ['T2', 'Lost', ['T2.1']],
    ]);
    expect(built.members.map((m) => m.ordinal)).toEqual(['M1', 'M2']);
    expect(currentTagOrdinal(built.tags, T_INT, T_ADCB)).toBe('T1.1');
    expect(currentTagOrdinal(built.tags, T_LOST, null)).toBe('T2');
    expect(currentTagOrdinal(built.tags, null, null)).toBeNull();
  });
});

describe('planActions', () => {
  it('turns ordinals into the real ids, one card per kind', () => {
    const out = planActions(
      json([
        { type: 'tag', tag: 'T1', sub: 'T1.1', why: 'They chose ADCB' },
        {
          type: 'task',
          title: 'Call back about documents',
          due_in_hours: 24,
          why: 'Promised',
        },
        { type: 'assign', member: 'M2', why: 'Omar handles ADCB' },
        { type: 'note', text: 'Wants a POS too', why: '' },
      ]),
      refs()
    );
    expect(out.map((a) => a.tool)).toEqual([
      'chat_set_tag',
      'chat_create_task',
      'chat_assign',
      'chat_add_note',
    ]);
    expect(out[0].args).toEqual({
      conversationId: CHAT,
      tagId: T_INT,
      subTagId: T_ADCB,
    });
    expect(out[0].view).toEqual({
      kind: 'tag',
      tagName: 'Interested',
      subTagName: 'ADCB',
    });
    expect(out[1].args).toEqual({
      conversationId: CHAT,
      title: 'Call back about documents',
      dueAt: '2026-11-27T08:00:00.000Z',
    });
    expect(out[2].args).toEqual({
      conversationId: CHAT,
      expected: U_SARA,
      userId: U_OMAR,
    });
    expect(out[3].args).toEqual({
      conversationId: CHAT,
      body: 'Wants a POS too',
    });
  });

  it('drops made-up ordinals, a sub-tag of another tag and ids from the model', () => {
    const out = planActions(
      json([
        { type: 'tag', tag: 'T9' },
        { type: 'tag', tag: 'T1', sub: 'T2.1' },
        { type: 'tag', tag: T_INT },
        { type: 'assign', member: U_OMAR },
        { type: 'assign', member: 'M7' },
        { type: 'send', text: 'Hello customer' },
        { type: 'delete_contact' },
      ]),
      refs()
    );
    expect(out).toEqual([]);
  });

  it('drops what is already so', () => {
    const out = planActions(
      json([
        { type: 'tag', tag: 'T1', sub: 'T1.1' },
        { type: 'assign', member: 'M1' },
      ]),
      refs({ currentTagId: T_INT, currentSubTagId: T_ADCB, assignedTo: U_SARA })
    );
    expect(out).toEqual([]);
  });

  it('keeps one per kind and at most four', () => {
    const out = planActions(
      json([
        { type: 'note', text: 'a' },
        { type: 'note', text: 'b' },
        { type: 'task', title: 't' },
        { type: 'tag', tag: 'T2' },
        { type: 'assign', member: 'M2' },
      ]),
      refs()
    );
    expect(out.map((a) => a.tool)).toEqual([
      'chat_add_note',
      'chat_create_task',
      'chat_set_tag',
      'chat_assign',
    ]);
  });

  it('cleans text: blank dropped, long clipped, bad due date left out', () => {
    const out = planActions(
      json([
        { type: 'note', text: '   ' },
        { type: 'task', title: 'x'.repeat(500), due_in_hours: 99999 },
      ]),
      refs()
    );
    expect(out).toHaveLength(1);
    const a = out[0].args as { title: string; dueAt: string | null };
    expect(a.title.length).toBeLessThanOrEqual(120);
    expect(a.dueAt).toBeNull();
    const note = planActions(
      json([{ type: 'note', text: 'n'.repeat(5000) }]),
      refs()
    );
    expect((note[0].args as { body: string }).body.length).toBeLessThanOrEqual(
      CHAT_ASSIST_NOTE_MAX
    );
  });

  it('survives prose, a code fence or garbage', () => {
    expect(extractJson('```json\n{"actions":[]}\n```')).toEqual({
      actions: [],
    });
    expect(planActions('no idea', refs())).toEqual([]);
    expect(planActions('{"actions": "lots"}', refs())).toEqual([]);
    expect(planActions('{broken', refs())).toEqual([]);
  });
});
