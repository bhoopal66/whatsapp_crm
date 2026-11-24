// ============================================================
// Template values in a v1 request body.
//
// A value that is not text used to be left out and the ones after it moved
// up: `["Jane", 50000, "5.9"]` was accepted and the customer read 5.9 as
// the amount. So every value is taken or the request is refused.
// ============================================================

import { badRequest } from '@/lib/api/v1/respond';

/** A string, or a finite number as text. */
function readValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  throw badRequest(`'${field}' must be a string or a number`);
}

/** Positional values, or undefined without any. Throws 400. */
export function readTemplateValues(
  value: unknown,
  field: string
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest(`'${field}' must be an array`);
  return value.map((v, i) => readValue(v, `${field}[${i}]`));
}

/**
 * `template.params` of POST /api/v1/messages: positional body values, or
 * the structured object (`SendTimeParams`). In the object's named fields
 * null means not given. Throws 400.
 */
export function readTemplateParams(value: unknown): {
  templateParams?: string[];
  templateMessageParams?: Record<string, unknown>;
} {
  const at = 'template.params';
  if (value === undefined || value === null) return {};
  if (Array.isArray(value)) {
    return { templateParams: readTemplateValues(value, at) };
  }
  if (typeof value !== 'object') {
    throw badRequest(`'${at}' must be an array or an object`);
  }

  const given: Record<string, unknown> = { ...value };
  const read: Record<string, unknown> = {
    ...given,
    body: readTemplateValues(given.body, `${at}.body`),
  };
  for (const key of ['headerText', 'headerMediaUrl', 'headerMediaId']) {
    read[key] =
      given[key] === undefined || given[key] === null
        ? undefined
        : readValue(given[key], `${at}.${key}`);
  }
  if (given.buttonParams === null) {
    read.buttonParams = undefined;
  } else if (given.buttonParams !== undefined) {
    if (typeof given.buttonParams !== 'object') {
      throw badRequest(`'${at}.buttonParams' must be an object`);
    }
    read.buttonParams = Object.fromEntries(
      Object.entries(given.buttonParams)
        .filter(([, v]) => v !== null)
        .map(([i, v]) => [i, readValue(v, `${at}.buttonParams[${i}]`)])
    );
  }
  return { templateMessageParams: read };
}
