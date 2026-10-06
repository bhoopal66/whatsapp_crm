/**
 * A contact card the customer shared in chat, in the one shape both
 * providers are normalised to and the inbox renders. Whapi delivers a
 * vCard string; the Cloud API delivers structured JSON. Neither is
 * stored raw — the card is what an agent needs to see and save.
 */
export interface SharedContact {
  name: string;
  /** As written on the card, e.g. `+971 50 123 4567`. */
  phones: string[];
  emails: string[];
  /** Organisation / company line, when the card has one. */
  org: string | null;
}

/** Undo vCard line folding (a line starting with a space/tab continues the previous one). */
function unfold(vcard: string): string[] {
  const out: string[] = [];
  for (const line of vcard.replace(/\r\n?/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** `TEL;type=CELL;waid=971501234567:+971 50 123 4567` → `+971 50 123 4567`. */
function valueOf(line: string): string {
  const idx = line.indexOf(':');
  return idx === -1 ? '' : line.slice(idx + 1).trim();
}

function propertyOf(line: string): string {
  const idx = line.indexOf(':');
  const head = idx === -1 ? line : line.slice(0, idx);
  return head.split(';')[0].trim().toUpperCase();
}

/**
 * The fields the inbox shows, out of a vCard 2.1/3.0/4.0 string. Tolerant:
 * a card with no FN falls back to N, then to the first phone, so a
 * shared number with no name still renders as a card rather than an
 * empty one. Returns `null` only when the text has neither a name nor a
 * phone — i.e. it isn't usefully a contact.
 */
export function parseVcard(vcard: string): SharedContact | null {
  let fn = '';
  let n = '';
  let org: string | null = null;
  const phones: string[] = [];
  const emails: string[] = [];

  for (const line of unfold(vcard)) {
    const prop = propertyOf(line);
    const value = valueOf(line);
    if (!value) continue;
    switch (prop) {
      case 'FN':
        fn = value;
        break;
      case 'N': {
        // N:Last;First;Middle;Prefix;Suffix
        const [last = '', first = '', middle = ''] = value.split(';');
        n = [first, middle, last].filter(Boolean).join(' ').trim();
        break;
      }
      case 'TEL':
        if (!phones.includes(value)) phones.push(value);
        break;
      case 'EMAIL':
        if (!emails.includes(value)) emails.push(value);
        break;
      case 'ORG':
        org = value.split(';')[0].trim() || null;
        break;
    }
  }

  const name = fn || n || phones[0] || '';
  if (!name && phones.length === 0) return null;
  return { name, phones, emails, org };
}

/** Meta Cloud API `contacts[]` entry on an inbound message. */
export interface MetaContactPayload {
  name?: {
    formatted_name?: string;
    first_name?: string;
    last_name?: string;
  };
  phones?: { phone?: string; wa_id?: string; type?: string }[];
  emails?: { email?: string; type?: string }[];
  org?: { company?: string; title?: string };
}

export function metaContactToShared(
  c: MetaContactPayload
): SharedContact | null {
  const phones = (c.phones ?? [])
    .map((p) => p.phone?.trim() || (p.wa_id ? `+${p.wa_id}` : ''))
    .filter((p, i, arr) => p && arr.indexOf(p) === i);
  const emails = (c.emails ?? [])
    .map((e) => e.email?.trim() ?? '')
    .filter((e, i, arr) => e && arr.indexOf(e) === i);
  const name =
    c.name?.formatted_name?.trim() ||
    [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ').trim() ||
    phones[0] ||
    '';
  if (!name && phones.length === 0) return null;
  return { name, phones, emails, org: c.org?.company?.trim() || null };
}

/** Preview line for the conversation list and search: the names on the card(s). */
export function contactCardsText(cards: SharedContact[]): string {
  const names = cards.map((c) => c.name).filter(Boolean);
  return names.length > 0 ? `Contact: ${names.join(', ')}` : 'Contact card';
}
