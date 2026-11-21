/**
 * The case desk caption parser (package 035b), pure. Case-insensitive,
 * tolerant of extra spaces. It never guesses: a case reference only when
 * a token has the caption-code shape ('4271RAKD') or the full case-number
 * shape ('TC-26-04271-RAK'); the check character is verified by the SQL
 * resolver.
 *
 *   '<ref> <doc words>'                    -> pending_doc
 *   'INFO <ref> <note>'                    -> info
 *   'NEW <BBB> <company words> <licence>'  -> new_case (BBB = desk code)
 *   anything else                          -> kind null, the caption as note
 */

export type CaptionParse =
  | { kind: 'pending_doc'; caseRef: string; docWord?: string }
  | { kind: 'info'; caseRef: string; note: string }
  | { kind: 'new_case'; deskCode: string; company: string; licence: string }
  | { kind: null; note: string };

const CAPTION_CODE = /^[1-9][0-9]{0,6}[A-Z]{3}[2-9]?[0-9A-Z]$/;
const FULL_NUMBER = /^TC-[0-9]{2}-([0-9]{5}|[1-9][0-9]{5,6})-[A-Z]{3}[2-9]?$/;
const DESK_CODE = /^[A-Z]{3}$/;
/** A trade licence token: 3-40 of letters, digits, '-' or '/', at least one digit. */
const LICENCE = /^(?=.*[0-9])[A-Z0-9/-]{3,40}$/;

/** The token as a case reference (upper-cased), or null. */
export function caseRefOf(token: string): string | null {
  const t = token.toUpperCase();
  return CAPTION_CODE.test(t) || FULL_NUMBER.test(t) ? t : null;
}

export function parseCaptionText(caption: string): CaptionParse {
  const text = caption.trim();
  const tokens = text.split(/\s+/).filter((t) => t !== '');
  const other: CaptionParse = { kind: null, note: text };
  if (tokens.length === 0) return other;
  const head = tokens[0]!.toUpperCase();

  if (head === 'INFO') {
    const ref = tokens[1] !== undefined ? caseRefOf(tokens[1]) : null;
    if (ref === null) return other;
    return { kind: 'info', caseRef: ref, note: tokens.slice(2).join(' ') };
  }

  if (head === 'NEW') {
    if (tokens.length < 4) return other;
    const desk = tokens[1]!.toUpperCase();
    const licence = tokens[tokens.length - 1]!.toUpperCase();
    if (!DESK_CODE.test(desk) || !LICENCE.test(licence)) return other;
    return {
      kind: 'new_case',
      deskCode: desk,
      company: tokens.slice(2, -1).join(' '),
      licence,
    };
  }

  const ref = caseRefOf(tokens[0]!);
  if (ref === null) return other;
  const docWord = tokens.slice(1).join(' ').toLowerCase();
  return docWord === ''
    ? { kind: 'pending_doc', caseRef: ref }
    : { kind: 'pending_doc', caseRef: ref, docWord };
}

/** A doc word as a doc_key ('trade licence' -> 'trade_licence'), or null. */
export function docKeyOf(docWord: string | undefined): string | null {
  if (docWord === undefined) return null;
  const k = docWord
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return /^[a-z0-9_]{1,64}$/.test(k) ? k : null;
}
