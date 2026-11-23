import { describe, expect, it } from 'vitest';

import {
  nextStep,
  parseLastMessage,
  snippet,
  summariseDocs,
  type DocsSummary,
} from './overview';

const STAGES = ['Interested', 'Docs', 'Submitted', 'Approved', 'Closed'];
const open = { stage: 'Docs', groupId: 'g', closedAt: null };
const may = { canWrite: true, stageLocked: false };
const docs = (over: Partial<DocsSummary> = {}): DocsSummary => ({
  required: 2,
  received: 2,
  rejected: 0,
  missing: [],
  ...over,
});

describe('summariseDocs', () => {
  it('counts received, rejected and lists missing labels in order', () => {
    const s = summariseDocs({
      items: [
        { docKey: 'b', label: 'Passport', position: 2, status: 'requested' },
        { docKey: 'a', label: 'Licence', position: 1, status: 'received' },
        { docKey: 'c', label: 'Visa', position: 3, status: 'rejected' },
      ],
    });
    expect(s).toEqual({
      required: 3,
      received: 1,
      rejected: 1,
      missing: ['Passport', 'Visa'],
    });
  });
  it('falls back to the key when there is no label', () => {
    expect(summariseDocs({ items: [{ docKey: 'x' }] })?.missing).toEqual(['x']);
  });
  it('is null for a body that is not a checklist', () => {
    expect(summariseDocs(null)).toBeNull();
    expect(summariseDocs({})).toBeNull();
  });
});

describe('nextStep', () => {
  it('is closed for a closed case', () => {
    expect(
      nextStep({ ...open, closedAt: 'x' }, STAGES, 'loading', may)
    ).toEqual({
      kind: 'closed',
    });
  });
  it('puts missing documents first', () => {
    expect(
      nextStep(open, STAGES, docs({ missing: ['A'], rejected: 1 }), may)
    ).toEqual({ kind: 'documents', missing: 1, rejected: 1 });
  });
  it('otherwise names the next stage', () => {
    expect(nextStep(open, STAGES, docs(), may)).toEqual({
      kind: 'move',
      stage: 'Submitted',
    });
  });
  it('advises nothing until the documents are known', () => {
    expect(nextStep(open, STAGES, 'loading', may)).toEqual({ kind: 'loading' });
    expect(nextStep(open, STAGES, 'failed', may)).toEqual({
      kind: 'docsFailed',
    });
  });
  it('never advises a move on a locked case or to someone who cannot write', () => {
    expect(
      nextStep(open, STAGES, docs(), { canWrite: true, stageLocked: true })
    ).toEqual({ kind: 'locked' });
    expect(
      nextStep(open, STAGES, docs(), { canWrite: false, stageLocked: false })
    ).toEqual({ kind: 'readOnly' });
    expect(
      nextStep(open, STAGES, docs({ missing: ['A'] }), {
        canWrite: false,
        stageLocked: true,
      }).kind
    ).toBe('documents');
  });
  it('has nothing to suggest at the end of the list', () => {
    expect(
      nextStep({ ...open, stage: 'Closed' }, STAGES, docs(), may).kind
    ).toBe('closed');
  });
});

describe('snippet / parseLastMessage', () => {
  it('shortens long text with an ellipsis and keeps short text', () => {
    expect(snippet('hello   there')).toBe('hello there');
    const long = 'word '.repeat(100);
    const s = snippet(long, 50);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(51);
  });
  it('parses the route body', () => {
    expect(
      parseLastMessage({
        message: { conversationId: 'c', text: ' hi ', at: 't' },
      })
    ).toEqual({ conversationId: 'c', text: ' hi ', at: 't' });
    expect(parseLastMessage({ message: null })).toBeNull();
    expect(
      parseLastMessage({ message: { conversationId: 'c', at: 't' } })?.text
    ).toBeNull();
  });
});
