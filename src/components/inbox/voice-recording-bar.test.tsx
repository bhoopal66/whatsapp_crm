import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';

import {
  VoiceFailedStrip,
  VoiceRecordingBar,
  VoiceWorkStrip,
} from './voice-recording-bar';

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );

const bar = (props: Partial<React.ComponentProps<typeof VoiceRecordingBar>>) =>
  html(
    <VoiceRecordingBar
      seconds={7}
      maxSeconds={300}
      getLevelSource={() => null}
      onCancel={() => {}}
      onStop={() => {}}
      {...props}
    />
  );

/** The bar's buttons, in order, with whether each can be pressed. */
const buttons = (markup: string) =>
  [...markup.matchAll(/<button\b[^>]*>/g)].map(([tag]) => [
    /aria-label="([^"]*)"/.exec(tag)?.[1],
    !/\sdisabled(=|\s|>)/.test(tag),
  ]);

describe('VoiceRecordingBar', () => {
  it('offers discard, listen first and, last, where the mic was, Send', () => {
    const markup = bar({ onSend: () => {} });
    expect(buttons(markup)).toEqual([
      ['Discard recording', true],
      ['Stop and listen before sending', true],
      ['Send voice note', true],
    ]);
    expect(markup).toContain('0:07');
    expect(markup).toContain('Listen first');
  });

  it('has a plain Stop for a caller that does not send', () => {
    expect(buttons(bar({}))).toEqual([
      ['Discard recording', true],
      ['Stop recording', true],
    ]);
  });

  it('says the mic is opening, and only lets that be given up', () => {
    const markup = bar({ starting: true, onSend: () => {} });
    expect(markup).toContain('Getting the microphone ready');
    expect(markup).not.toContain('0:07');
    expect(buttons(markup)).toEqual([
      ['Discard recording', true],
      ['Stop and listen before sending', false],
      ['Send voice note', false],
    ]);
    expect(buttons(bar({ starting: true }))[1]).toEqual([
      'Stop recording',
      false,
    ]);
  });
});

describe('the strips above the composer', () => {
  it('say what is happening to a recording', () => {
    expect(html(<VoiceWorkStrip kind="send" />)).toContain(
      'Sending voice note'
    );
    expect(html(<VoiceWorkStrip kind="review" />)).toContain(
      'Getting your recording ready'
    );
  });

  it('keep a recording that could not be uploaded', () => {
    const markup = html(
      <VoiceFailedStrip onRetry={() => {}} onDiscard={() => {}} />
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The recording is still here.');
    expect(markup).toContain('Try again');
    expect(markup).toContain('Discard recording');
    expect(
      html(
        <VoiceFailedStrip disabled onRetry={() => {}} onDiscard={() => {}} />
      )
    ).toMatch(/disabled[^>]*>Try again/);
  });
});
