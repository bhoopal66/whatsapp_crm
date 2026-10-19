// Ported from wacrm module 019a (assistant safety), reference package 2026-10-18. "workspace" here means the wacrm
// account id (uuid).
/**
 * Canonical JSON and the action hash that binds a human confirmation to one exact {tool, args}.
 * Object keys are sorted recursively; only JSON values are accepted (no undefined, functions, symbols,
 * bigint, non-finite numbers), so two calls hash equal iff they are the same JSON action.
 */
import { createHash } from 'node:crypto';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError('canonicalJson: only plain objects');
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not JSON`);
  }
}

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 of the canonical JSON of {tool, args}. */
export const actionHash = (tool: string, args: unknown): string =>
  sha256Hex(canonicalJson({ tool, args }));
