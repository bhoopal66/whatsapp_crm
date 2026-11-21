import { describe, expect, it } from 'vitest';
import {
  MAX_GSM7_CHARS,
  MAX_UCS2_CHARS,
  measureSms,
  smsEncoding,
} from './sms-text';

describe('smsEncoding', () => {
  it('plain English and the GSM basic accents are GSM-7', () => {
    expect(smsEncoding('Hi Ana, your interview is at 10:00.')).toBe('gsm-7bit');
    expect(smsEncoding('Café à Zürich, £5 @ 3pm\n')).toBe('gsm-7bit');
  });

  it('Arabic, emoji and escape-table characters are Unicode', () => {
    expect(smsEncoding('مرحبا')).toBe('unicode');
    expect(smsEncoding('Hi 👋')).toBe('unicode');
    expect(smsEncoding('Price €5')).toBe('unicode');
    expect(smsEncoding('{name}')).toBe('unicode');
  });
});

describe('measureSms', () => {
  it('counts GSM-7 segments at 160, then 153', () => {
    expect(measureSms('')).toMatchObject({ segments: 0, fits: true });
    expect(measureSms('a'.repeat(160))).toMatchObject({ segments: 1 });
    expect(measureSms('a'.repeat(161))).toMatchObject({ segments: 2 });
    expect(measureSms('a'.repeat(306))).toMatchObject({ segments: 2 });
    expect(measureSms('a'.repeat(307))).toMatchObject({ segments: 3 });
    expect(measureSms('a'.repeat(MAX_GSM7_CHARS))).toMatchObject({
      segments: 3,
      fits: true,
    });
    expect(measureSms('a'.repeat(MAX_GSM7_CHARS + 1))).toMatchObject({
      segments: 4,
      fits: false,
    });
  });

  it('counts Unicode segments at 70, then 67, in UTF-16 units', () => {
    expect(measureSms('م'.repeat(70))).toMatchObject({
      encoding: 'unicode',
      segments: 1,
    });
    expect(measureSms('م'.repeat(71))).toMatchObject({ segments: 2 });
    expect(measureSms('م'.repeat(MAX_UCS2_CHARS))).toMatchObject({
      segments: 3,
      fits: true,
    });
    expect(measureSms('م'.repeat(MAX_UCS2_CHARS + 1))).toMatchObject({
      fits: false,
    });
    // An emoji is two UTF-16 units.
    expect(measureSms('👋').length).toBe(2);
  });
});
