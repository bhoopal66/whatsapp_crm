import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import { VoiceNotePlayer } from './voice-note-player';

// Server-rendered: no effects run, so nothing loads; this pins the markup
// each tone starts with.
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={en as unknown as AbstractIntlMessages}
    >
      {el}
    </NextIntlClientProvider>
  );

describe('VoiceNotePlayer', () => {
  it("renders the team-chat tone on the theme's tokens", () => {
    const html = render(
      <VoiceNotePlayer src={null} seed="m1" tone="chat" knownDuration={42} />
    );
    expect(html).toContain('aria-label="Play voice message"');
    expect(html).toContain('bg-card-2');
    expect(html).toContain('bg-primary text-primary-foreground');
    expect(html).not.toContain('wa-');
    // The sender's length stands in until the real one is known.
    expect(html).toContain('0:42');
  });

  it('keeps the inbox bubbles on their WhatsApp palette', () => {
    const inbound = render(
      <VoiceNotePlayer src="https://x.test/a.ogg" seed="m1" tone="in" />
    );
    expect(inbound).toContain('bg-wa-green text-wa-green-fg');
    expect(inbound).toContain('shadow-[0_0_0_2px_var(--wa-bubble-in)]');
    expect(inbound).not.toContain('bg-card-2');
    expect(inbound).toContain('0:00');
    const outbound = render(
      <VoiceNotePlayer src="https://x.test/a.ogg" seed="m1" tone="out" />
    );
    expect(outbound).toContain('bg-wa-text text-wa-bubble-out');
    expect(outbound).toContain('shadow-[0_0_0_2px_var(--wa-bubble-out)]');
  });

  it('shows the can-not-play state when the source is unavailable', () => {
    const html = render(
      <VoiceNotePlayer src={null} seed="m1" tone="chat" unavailable />
    );
    expect(html).toContain('Can&#x27;t play this voice message');
  });
});
