// ============================================================
// A Content-Security-Policy violation report, reduced to what decides
// whether the policy can be enforced: which rule, what origin it blocked,
// on which screen. The report's own URLs can carry ids and queries, so
// none is kept whole. Pure.
// ============================================================

import { maskPath } from './client-errors';

export interface CspViolation {
  directive: string;
  blocked: string;
  path: string;
}

function originOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return '(none)';
  // `inline`, `eval`, `data`, `blob`, … are keywords, not addresses.
  if (/^[a-z-]{2,20}$/i.test(value)) return value.toLowerCase();
  try {
    const u = new URL(value);
    return u.host ? `${u.protocol}//${u.host}`.slice(0, 120) : u.protocol;
  } catch {
    return '(unreadable)';
  }
}

function pathOf(value: unknown): string {
  if (typeof value !== 'string') return '/';
  try {
    return maskPath(new URL(value).pathname);
  } catch {
    return '/';
  }
}

function one(raw: unknown): CspViolation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const directive =
    r['effective-directive'] ??
    r.effectiveDirective ??
    r['violated-directive'] ??
    r.violatedDirective;
  if (typeof directive !== 'string') return null;
  const name = directive.trim().split(/\s+/)[0] ?? '';
  if (!/^[a-z-]{3,30}$/.test(name)) return null;
  return {
    directive: name,
    blocked: originOf(r['blocked-uri'] ?? r.blockedURL),
    path: pathOf(r['document-uri'] ?? r.documentURL),
  };
}

/** Both wire forms: `report-uri` (one object) and the Reporting API (a list). */
export function parseCspReport(body: unknown): CspViolation[] {
  if (Array.isArray(body)) {
    return body
      .slice(0, 20)
      .filter(
        (e) =>
          !!e &&
          typeof e === 'object' &&
          (e as Record<string, unknown>).type === 'csp-violation'
      )
      .map((e) => one((e as Record<string, unknown>).body))
      .filter((v): v is CspViolation => v !== null);
  }
  const v = one((body as Record<string, unknown> | null)?.['csp-report']);
  return v ? [v] : [];
}

/** An extension's own injection says nothing about this app. */
export function worthKeeping(v: CspViolation): boolean {
  return !/-extension:/.test(v.blocked);
}
