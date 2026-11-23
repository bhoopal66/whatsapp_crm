import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { roomSendOutcome } from './send-outcome';

const kind = (status: number, body: unknown = null) =>
  roomSendOutcome({ status, body }).kind;

describe('roomSendOutcome', () => {
  it('is sent on a 201, and says when it was not recorded', () => {
    expect(kind(201, { id: 'gm-1', waMessageId: 'w' })).toBe('sent');
    expect(kind(201, { id: null, waMessageId: 'w' })).toBe('notRecorded');
    // The answer's body was lost on the way: it went out all the same.
    expect(kind(201)).toBe('sent');
  });

  it('is unconfirmed when nobody can know', () => {
    expect(roomSendOutcome(null).kind).toBe('unconfirmed');
    expect(kind(502, { code: 'unconfirmed' })).toBe('unconfirmed');
    for (const status of [408, 500, 502, 503, 504, 524]) {
      expect(kind(status), String(status)).toBe('unconfirmed');
    }
  });

  it('is refused on every other 4xx and on a 5xx that names a refusal', () => {
    expect(
      roomSendOutcome({ status: 409, body: { code: 'window_closed' } })
    ).toEqual({ kind: 'refused', error: 'window_closed' });
    expect(
      roomSendOutcome({ status: 502, body: { code: 'media_upload' } })
    ).toEqual({ kind: 'refused', error: 'media_upload' });
    for (const answer of [
      { status: 429, body: {} },
      { status: 413, body: null },
      { status: 409, body: { code: 'group_gone' } },
      { status: 502, body: { code: 'meta_error' } },
    ]) {
      expect(roomSendOutcome(answer)).toEqual({
        kind: 'refused',
        error: 'generic',
      });
    }
  });

  it('is what the composer asks, whatever happened to the request', () => {
    const src = readFileSync('src/components/deal-rooms/room-view.tsx', 'utf8');
    expect(src).toMatch(/const outcome = roomSendOutcome\(answer\)/);
    // The words and the file go only when the message did.
    expect(src).toMatch(
      /return outcome\.kind === 'sent' \|\| outcome\.kind === 'notRecorded'/
    );
    expect(src).toMatch(/setUnconfirmed\(outcome\.kind === 'unconfirmed'\)/);
    expect(src).toContain("t('composer.errors.unconfirmed')");
    expect(src).toContain("t('composer.notRecorded')");
  });
});
