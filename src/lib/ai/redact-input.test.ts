import { describe, expect, it } from 'vitest';
import {
  echoesRedaction,
  redactForProvider,
  redactMessages,
  redactOwnText,
} from './redact-input';
import { buildDraftMessages } from './draft-prompt';

describe('redactForProvider', () => {
  it.each([
    ['my id is 784-1990-1234567-1', '1234567', '[EID]'],
    ['card 4111 1111 1111 1111 ok', '4111', '[CARD]'],
    ['IBAN AE07 0331 2345 6789 0123 456', '0331', '[IBAN]'],
    ['call 0501234567', '0501234', '[PHONE:567]'],
    ['passport no A1234567', '1234567', '[PASSPORT]'],
  ])('%s', (text, raw, mask) => {
    const out = redactForProvider(text);
    expect(out).not.toContain(raw);
    expect(out).toContain(mask);
  });

  it('keeps the amounts and dates the bot has to read', () => {
    for (const t of [
      'my salary is 25000',
      'turnover 1500000 and 2,500,000 AED last year',
      'salary 18,500 since 01/02/2024, company started 2019',
      '[2026-11-23 10:05] Customer: we need 500000',
    ]) {
      expect(redactForProvider(t)).toBe(t);
    }
  });
});

describe('the draft', () => {
  const typed = 'call me on 0501234567';
  const build = (t: string) =>
    redactMessages(
      buildDraftMessages({
        rows: [
          {
            sender_type: 'customer',
            content_type: 'text',
            content_text: 'ID 784-1990-1234567-1, reach me on 0509876543',
            created_at: '2026-11-23T10:00:00Z',
          },
        ],
        typed: t,
      })!
    )[0]!.content;

  it('masks the transcript and keeps the number the agent typed', () => {
    const out = build(typed);
    expect(out).toContain(typed);
    expect(out).not.toContain('1234567-1');
    expect(out).not.toContain('0509876543');
  });

  it('masks an identifier the agent typed', () => {
    expect(build('your card 4111 1111 1111 1111')).not.toContain('4111');
  });
});

it('keeps the wording of our own text unless it holds an identifier', () => {
  expect(redactOwnText('Call 04 123 4567?')).toBe('Call 04 123 4567?');
  expect(redactOwnText('ID 784-1990-1234567-1?')).toBe('ID [EID]?');
});

it('spots a mask the model repeated', () => {
  expect(echoesRedaction('Is [PHONE:567] still right?')).toBe(true);
  expect(echoesRedaction('Is [your company] a LLC?')).toBe(false);
});
