import { describe, expect, it } from 'vitest';

import type { AttachmentInput, ChatAttachment } from '../types';
import {
  CHAT_VOICE_MAX_SECONDS,
  REMINT_MIN_AGE_MS,
  attachmentDisplay,
  claimVoicePlay,
  hidesVoiceBody,
  shouldRemint,
  voiceAttachment,
  voiceDurationMs,
  voiceFileName,
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

  it('keeps images and other files as they were, and plays video', () => {
    expect(attachmentDisplay(att({ kind: 'file', mime: 'image/png' }))).toBe(
      'image'
    );
    expect(
      attachmentDisplay(att({ kind: 'file', mime: 'application/pdf' }))
    ).toBe('file');
    expect(attachmentDisplay(att({ kind: 'file', mime: 'video/mp4' }))).toBe(
      'video'
    );
    expect(attachmentDisplay(att({ kind: 'file', mime: 'Video/WebM' }))).toBe(
      'video'
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

describe('CHAT_VOICE_MAX_SECONDS', () => {
  it('caps a take at 15 minutes, inside the database bound', () => {
    expect(CHAT_VOICE_MAX_SECONDS).toBe(900);
    expect(CHAT_VOICE_MAX_SECONDS * 1000).toBeLessThanOrEqual(1_200_000);
  });
});

describe('voiceDurationMs', () => {
  it('measures the take in whole milliseconds', () => {
    expect(voiceDurationMs(1000, 43_000.4)).toBe(42_000);
    expect(voiceDurationMs(10.2, 12.9)).toBe(3);
  });

  it('never goes below 1 ms', () => {
    expect(voiceDurationMs(500, 500)).toBe(1);
    expect(voiceDurationMs(500, 500.2)).toBe(1);
    expect(voiceDurationMs(900, 100)).toBe(1);
    expect(voiceDurationMs(0, Number.NaN)).toBe(1);
  });

  it('never goes above the database cap of 20 minutes', () => {
    expect(voiceDurationMs(0, 1_200_000)).toBe(1_200_000);
    expect(voiceDurationMs(0, 1_200_001)).toBe(1_200_000);
    expect(voiceDurationMs(0, 5_000_000)).toBe(1_200_000);
  });
});

describe('voiceFileName', () => {
  it('names the take after the local time it was recorded', () => {
    // The local-time constructor keeps this independent of the TZ.
    expect(voiceFileName(new Date(2026, 9, 30, 7, 5, 9))).toBe(
      'voice-20261030-070509.ogg'
    );
    expect(voiceFileName(new Date(2027, 0, 1, 23, 59, 59))).toBe(
      'voice-20270101-235959.ogg'
    );
  });
});

describe('voiceAttachment', () => {
  const upload = (over: Partial<AttachmentInput> = {}): AttachmentInput => ({
    storage_path: 'account-a/channel-c/u-voice.ogg',
    name: 'voice-20261030-070509.ogg',
    mime: 'audio/ogg',
    bytes: 12_000,
    ...over,
  });

  it('marks the upload as a voice note with its duration', () => {
    expect(voiceAttachment(upload(), 42_000)).toEqual({
      storage_path: 'account-a/channel-c/u-voice.ogg',
      name: 'voice-20261030-070509.ogg',
      mime: 'audio/ogg',
      bytes: 12_000,
      kind: 'voice',
      duration_ms: 42_000,
    });
  });

  it('keeps an audio mime the browser gave', () => {
    expect(voiceAttachment(upload({ mime: 'audio/webm' }), 5).mime).toBe(
      'audio/webm'
    );
  });

  it('falls back to audio/ogg when the browser left the type blank', () => {
    expect(voiceAttachment(upload({ mime: '' }), 5).mime).toBe('audio/ogg');
    expect(voiceAttachment(upload({ mime: '  ' }), 5).mime).toBe('audio/ogg');
    // uploadChatFile stores a blank type as application/octet-stream.
    expect(
      voiceAttachment(upload({ mime: 'application/octet-stream' }), 5).mime
    ).toBe('audio/ogg');
  });
});
