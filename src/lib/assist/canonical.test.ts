// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18 (test/019a/loop.test.ts,
// "019a canonical hash").
import { describe, expect, it } from 'vitest';
import { actionHash, canonicalJson, sha256Hex } from './canonical';

describe('019a canonical hash', () => {
  it('is key-order independent and changes with any arg', () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      '{"a":[{"x":1,"y":2}],"b":1}'
    );
    expect(actionHash('t', { a: 1, b: 2 })).toBe(
      actionHash('t', { b: 2, a: 1 })
    );
    expect(actionHash('t', { a: { d: 1, c: 2 } })).toBe(
      actionHash('t', { a: { c: 2, d: 1 } })
    );
    expect(actionHash('t', { a: 1 })).not.toBe(actionHash('t', { a: 2 }));
    expect(actionHash('t', { a: 1 })).not.toBe(actionHash('u', { a: 1 }));
  });

  it('is the sha256 of the canonical {tool, args}', () => {
    expect(actionHash('t', { b: 2, a: 1 })).toBe(
      sha256Hex('{"args":{"a":1,"b":2},"tool":"t"}')
    );
    expect(actionHash('t', {})).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts only JSON values', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(BigInt(1))).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(canonicalJson(Object.create(null))).toBe('{}');
  });
});
