import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';

// The node environment cannot press the button or play audio, so this
// pins which rows carry the Play control, what it says open and closed,
// and that rendering it fetches nothing (the link is asked for on Play).

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountRole: 'agent' }),
}));

import { CallRecordingToggle, recordingPanelId } from './call-recording';

function render(
  call: { recordingState: string; recordingDeleted?: boolean },
  open = false
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <CallRecordingToggle
        call={{ id: 'c1', ...call }}
        open={open}
        onToggle={() => {}}
      />
    </NextIntlClientProvider>
  );
}

describe('CallRecordingToggle', () => {
  it('offers Play on a stored recording, without fetching anything', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const html = render({ recordingState: 'fetched' });
    expect(html).toContain(`aria-label="${en.CallsPage.playRecording}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('says Hide and names its panel while open', () => {
    const html = render({ recordingState: 'fetched' }, true);
    expect(html).toContain(`aria-label="${en.CallsPage.hideRecording}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(`aria-controls="${recordingPanelId('c1')}"`);
  });

  it('renders nothing where there is no audio to play', () => {
    expect(render({ recordingState: 'none' })).toBe('');
    expect(render({ recordingState: 'held' })).toBe('');
    expect(render({ recordingState: 'pending' })).toBe('');
    expect(render({ recordingState: 'fetched', recordingDeleted: true })).toBe(
      ''
    );
  });
});
