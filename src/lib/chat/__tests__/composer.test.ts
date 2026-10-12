import { describe, expect, it } from 'vitest';

import {
  acceptFiles,
  blockFromError,
  composeBody,
  composerBlock,
  decodeDraft,
  deserializeBody,
  draftStorageKey,
  encodeDraft,
  filesOnlyBody,
  insertAtMention,
  mentionCandidates,
  mentionLabel,
  serializeDraft,
  withPick,
} from '../composer';
import type { ChatPerson } from '../types';

const SARA = '11111111-1111-4111-8111-111111111111';
const SARA_K = '22222222-2222-4222-8222-222222222222';
const SARA_2 = '33333333-3333-4333-8333-333333333333';
const OMAR = '44444444-4444-4444-8444-444444444444';
const tok = (id: string) => `<@${id}>`;
const person = (userId: string, fullName: string | null): ChatPerson => ({
  userId,
  fullName,
  avatarUrl: null,
  role: 'agent',
  bankCode: null,
  presenceStatus: null,
  lastSeenAt: null,
});

describe('serializeDraft', () => {
  const picked = [
    { userId: SARA, label: 'Sara Ahmed' },
    { userId: SARA_K, label: 'Sara Khan' },
  ];
  it('turns exact @labels into tokens, every occurrence', () => {
    expect(
      serializeDraft('@Sara Ahmed hi, @Sara Khan and @Sara Ahmed again', picked)
    ).toBe(`${tok(SARA)} hi, ${tok(SARA_K)} and ${tok(SARA)} again`);
  });
  it('keeps two people with the same first name apart', () => {
    expect(serializeDraft('@Sara Khan, @Sara Ahmed.', picked)).toBe(
      `${tok(SARA_K)}, ${tok(SARA)}.`
    );
  });
  it('leaves a deleted or edited chip as plain text', () => {
    expect(serializeDraft('@Sara Ahme said', picked)).toBe('@Sara Ahme said');
    expect(serializeDraft('Sara Ahmed said', picked)).toBe('Sara Ahmed said');
    expect(serializeDraft('@Sara Ahmedi', picked)).toBe('@Sara Ahmedi');
    expect(serializeDraft('mail@Sara Ahmed', picked)).toBe('mail@Sara Ahmed');
    expect(serializeDraft('nothing picked', [])).toBe('nothing picked');
  });
  it('prefers the longest label and respects word edges', () => {
    const p = [
      { userId: OMAR, label: 'Sara' },
      { userId: SARA, label: 'Sara Ahmed' },
    ];
    expect(serializeDraft('@Sara Ahmed / @Sara / @Sara Ahmedx', p)).toBe(
      `${tok(SARA)} / ${tok(OMAR)} / ${tok(OMAR)} Ahmedx`
    );
    expect(serializeDraft("(@Sara Ahmed's)\n@Sara", p)).toBe(
      `(${tok(SARA)}'s)\n${tok(OMAR)}`
    );
  });
  it('escapes labels and keeps same-name people apart by suffix', () => {
    const first = withPick([], { userId: SARA, label: 'Sara Ahmed' });
    const label = mentionLabel('Sara  Ahmed', SARA_2, first);
    expect(label).toBe('Sara Ahmed (2)');
    expect(mentionLabel('Sara Ahmed', SARA, first)).toBe('Sara Ahmed');
    const both = withPick(first, { userId: SARA_2, label });
    expect(serializeDraft('@Sara Ahmed (2) and @Sara Ahmed', both)).toBe(
      `${tok(SARA_2)} and ${tok(SARA)}`
    );
    expect(withPick(both, { userId: SARA, label: 'x' })).toHaveLength(2);
    expect(serializeDraft('@a.b', [{ userId: OMAR, label: 'a+b' }])).toBe(
      '@a.b'
    );
  });
  it('round-trips a stored body', () => {
    const people = new Map([
      [SARA, { fullName: 'Sara Ahmed' }],
      [SARA_2, { fullName: 'Sara Ahmed' }],
    ]);
    const body = `${tok(SARA)} ${tok(SARA_2)} ${tok(OMAR)} ${tok(SARA)}`;
    const d = deserializeBody(body.toUpperCase().replace(/<@/g, '<@'), people);
    expect(d.text).toBe(
      `@Sara Ahmed @Sara Ahmed (2) ${tok(OMAR).toUpperCase()} @Sara Ahmed`
    );
    expect(serializeDraft(deserializeBody(body, people).text, d.picked)).toBe(
      body
    );
  });
});

describe('mention input', () => {
  it('replaces the @query at the caret and adds one space', () => {
    expect(insertAtMention('hi @sa', 6, '@Sara Ahmed')).toEqual({
      text: 'hi @Sara Ahmed ',
      caret: 15,
    });
    expect(insertAtMention('hi @sa there', 6, '@Sara Ahmed')).toEqual({
      text: 'hi @Sara Ahmed there',
      caret: 15,
    });
    expect(insertAtMention('x', 1, '@here')).toEqual({
      text: 'x @here ',
      caret: 8,
    });
  });
  it('lists named people by prefix, then broadcasts', () => {
    const people = [
      person(OMAR, 'Omar Sara'),
      person(SARA_K, 'Sara Khan'),
      person(SARA, 'sara ahmed'),
      person(SARA_2, null),
    ];
    const c = mentionCandidates(people, 'Sa', { broadcasts: false });
    expect(c.map((x) => x.type === 'person' && x.name)).toEqual([
      'sara ahmed',
      'Sara Khan',
      'Omar Sara',
    ]);
    const h = mentionCandidates(people, 'h', { broadcasts: true });
    expect(h).toEqual([{ type: 'broadcast', kind: 'here' }]);
    expect(
      mentionCandidates(people, '', { broadcasts: true, limit: 1 })
    ).toHaveLength(3);
  });
});

describe('drafts, files and body', () => {
  it('keys drafts per channel and thread, and decodes tolerantly', () => {
    expect(draftStorageKey('AB')).toBe('wacrm.chat.draft.ab');
    expect(draftStorageKey('ab', 'CD')).toBe('wacrm.chat.draft.ab.cd');
    expect(encodeDraft({ text: '  ', picked: [] })).toBeNull();
    const raw = encodeDraft({
      text: 'hi @Sara Ahmed',
      picked: [
        { userId: SARA, label: 'Sara Ahmed' },
        { userId: OMAR, label: 'Omar' },
      ],
    });
    expect(decodeDraft(raw)).toEqual({
      text: 'hi @Sara Ahmed',
      picked: [{ userId: SARA, label: 'Sara Ahmed' }],
    });
    expect(decodeDraft('{bad')).toEqual({ text: '', picked: [] });
    expect(
      decodeDraft(JSON.stringify({ text: 'x', picked: [{ userId: 'no' }] }))
    ).toEqual({ text: 'x', picked: [] });
  });
  it('accepts files within 25 MB and 10 in all', () => {
    const f = (size: number) => ({ name: 'a', size });
    expect(acceptFiles(0, [f(1), f(26214400)])).toEqual({
      accepted: [f(1), f(26214400)],
      rejected: null,
    });
    expect(acceptFiles(0, [f(26214401), f(2)]).rejected).toBe('fileTooLarge');
    const r = acceptFiles(9, [f(1), f(2)]);
    expect(r).toEqual({ accepted: [f(1)], rejected: 'tooManyFiles' });
  });
  it('composes a body the RPC accepts', () => {
    const picked = [{ userId: SARA, label: 'Sara Ahmed' }];
    expect(composeBody('  @Sara Ahmed ok \n', picked, [])).toEqual({
      ok: true,
      body: `${tok(SARA)} ok`,
    });
    expect(composeBody(' \n ', [], [])).toEqual({ ok: false, reason: 'empty' });
    expect(composeBody('', [], ['a.pdf', ' b.png '])).toEqual({
      ok: true,
      body: 'a.pdf, b.png',
    });
    expect(composeBody('😀'.repeat(8000), [], [])).toEqual({
      ok: true,
      body: '😀'.repeat(8000),
    });
    expect(composeBody('x'.repeat(8001), [], [])).toEqual({
      ok: false,
      reason: 'bodyLength',
    });
    expect([...filesOnlyBody(['n'.repeat(9000)])]).toHaveLength(8000);
    expect(filesOnlyBody([' '])).toBe('file');
  });
});

describe('composerBlock', () => {
  const base = {
    kind: 'team' as const,
    archived: false,
    member: false,
    bankGuest: false,
    chatEnabled: true,
  };
  it('mirrors chat_assert_can_write', () => {
    expect(composerBlock(base)).toBeNull();
    expect(composerBlock({ ...base, chatEnabled: false, archived: true })).toBe(
      'disabled'
    );
    expect(composerBlock({ ...base, archived: true })).toBe('archived');
    expect(
      composerBlock({
        ...base,
        kind: 'deal_room',
        bankGuest: true,
        member: true,
      })
    ).toBe('guestNotes');
    expect(composerBlock({ ...base, bankGuest: true, member: true })).toBe(
      'guestPrivateOnly'
    );
    expect(
      composerBlock({ ...base, kind: 'private', bankGuest: true, member: true })
    ).toBeNull();
    expect(composerBlock({ ...base, kind: 'private' })).toBe('notMember');
    expect(composerBlock({ ...base, kind: 'dm', member: true })).toBeNull();
    expect(blockFromError('archived')).toBe('archived');
    expect(blockFromError('notChannelMember')).toBe('notMember');
    expect(blockFromError('bodyLength')).toBeNull();
  });
});
