import { describe, expect, it } from 'vitest';

import type { ChatAttachment } from '../types';
import {
  REMINT_MIN_AGE_MS,
  attachmentDisplay,
  claimVoicePlay,
  hidesVoiceBody,
  shouldRemint,
} from '../voice';

const att = (over: Partial<ChatAttachment> = {}): ChatAttachment => ({
  id: 'a1',
  messageId: 'm1',
  storagePath: 'ws/ch/a1.ogg',
  name: 'voice.ogg',
  mime: 'audio/ogg',
  bytes: 12_000,
  kind: 'voice',
  durationMs: 42_000,
  ...over,
});

describe('attachmentDisplay', () => {
  it('plays a voice note as a voice note', () => {
    expect(attachmentDisplay(att())).toBe('voice');
  });

  it('plays any other audio file as audio', () => {
    expect(attachmentDisplay(att({ kind: 'file', mime: 'audio/mpeg' }))).toBe(
      'audio'
    );
    expect(attachmentDisplay(att({ kind: 'file', mime: 'Audio/OGG' }))).toBe(
      'audio'
    );
  });

  it('keeps images and other files as they were', () => {
    expect(attachmentDisplay(att({ kind: 'file', mime: 'image/png' }))).toBe(
      'image'
    );
    expect(
      attachmentDisplay(att({ kind: 'file', mime: 'application/pdf' }))
    ).toBe('file');
    expect(attachmentDisplay(att({ kind: 'file', mime: 'video/mp4' }))).toBe(
      'file'
    );
  });
});

describe('hidesVoiceBody', () => {
  const msg = (
    attachments: ChatAttachment[],
    over: { editedAt?: string | null; deletedAt?: string | null } = {}
  ) => ({ attachments, editedAt: null, deletedAt: null, ...over });

  it('hides the automatic label of a voice-only message', () => {
    expect(hidesVoiceBody(msg([att()]))).toBe(true);
  });

  it('shows the body once it was edited', () => {
    expect(
      hidesVoiceBody(msg([att()], { editedAt: '2026-10-30T10:00:00Z' }))
    ).toBe(false);
  });

  it('shows the body of anything that is not a lone voice note', () => {
    expect(hidesVoiceBody(msg([]))).toBe(false);
    expect(hidesVoiceBody(msg([att({ kind: 'file' })]))).toBe(false);
    expect(hidesVoiceBody(msg([att(), att({ id: 'a2', kind: 'file' })]))).toBe(
      false
    );
  });

  it('leaves a deleted message to its deleted line', () => {
    expect(
      hidesVoiceBody(msg([att()], { deletedAt: '2026-10-30T10:00:00Z' }))
    ).toBe(false);
  });
});

describe('shouldRemint', () => {
  it('does not mint again for a fresh URL that failed', () => {
    expect(shouldRemint(1_000, 1_000)).toBe(false);
    expect(shouldRemint(1_000, 1_000 + REMINT_MIN_AGE_MS - 1)).toBe(false);
  });

  it('mints again for a URL old enough to have expired', () => {
    expect(shouldRemint(1_000, 1_000 + REMINT_MIN_AGE_MS)).toBe(true);
    expect(shouldRemint(1_000, 1_000 + 301_000)).toBe(true);
  });
});

describe('claimVoicePlay', () => {
  it('claims once per message', () => {
    const seen = new Set<string>();
    expect(claimVoicePlay(seen, 'm1', 'u-me', 'u-them')).toBe(true);
    expect(claimVoicePlay(seen, 'm1', 'u-me', 'u-them')).toBe(false);
    expect(claimVoicePlay(seen, 'm2', 'u-me', 'u-them')).toBe(true);
  });

  it("never claims the author's own play, whatever the case", () => {
    const seen = new Set<string>();
    expect(claimVoicePlay(seen, 'm1', 'ABC', 'abc')).toBe(false);
    expect(seen.size).toBe(0);
  });

  it('needs a known viewer', () => {
    expect(claimVoicePlay(new Set(), 'm1', null, 'u-them')).toBe(false);
  });
});
