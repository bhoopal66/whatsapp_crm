// Call service details (migration 336): after an agent handles a
// customer's call, the customer gets one approved utility WhatsApp
// template naming the service. Pure rules here; the database side is
// injected (ServiceDetailsPorts) so the order of the checks is pinned by
// tests. Package release 028, adapted: any contact of the account, the
// Yeastar call end (process.ts), not Voicenter.

export type ServiceDetailsOutcome =
  | 'duplicate'
  | 'switched_off'
  | 'not_answered'
  | 'no_agent'
  | 'too_short'
  | 'direction_off'
  | 'bad_number'
  | 'no_contact'
  | 'ambiguous_contact'
  | 'opted_out'
  | 'no_template'
  | 'daily_cap'
  | 'sent'
  | 'send_failed'
  | 'error';

export interface ServiceDetailsSettings {
  enabled: boolean;
  templateName: string | null;
  language: string | null;
  minSeconds: number;
  inbound: boolean;
  outbound: boolean;
}

export const DEFAULT_SERVICE_DETAILS_SETTINGS: ServiceDetailsSettings = {
  enabled: false,
  templateName: null,
  language: null,
  minSeconds: 20,
  inbound: true,
  outbound: false,
};

export type ServiceMatchType = 'queue' | 'did' | 'extension';

export interface ServiceMapRow {
  matchType: ServiceMatchType;
  matchValue: string;
  label: string;
}

/** The finished call as process.ts recorded it (the merged legs). */
export interface FinishedCall {
  callRowId: string;
  accountId: string;
  direction: 'inbound' | 'outbound' | 'internal';
  answered: boolean;
  /** The extension that handled it; null when only an IVR or queue did. */
  agentExtension: string | null;
  /** True when that extension is a known agent extension. */
  agentKnown: boolean;
  talkSeconds: number;
  /** The customer's number as the PBX gave it. */
  customerNumber: string | null;
  queue?: string | null;
  did?: string | null;
}

export const SERVICE_FALLBACK = 'your enquiry';

/**
 * UAE-default E.164 (SPEC 028 section 3): separators stripped, 00 -> +,
 * a leading trunk 0 -> +971, a bare 9-digit number -> +971; anything
 * else not 8..15 digits is null.
 */
export function toE164(raw: string | null | undefined, country = '971') {
  let s = (raw ?? '').replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = country + s.slice(1);
  else if (!s.startsWith(country) && s.length === 9) s = country + s;
  return /^[1-9]\d{7,14}$/.test(s) ? `+${s}` : null;
}

/** Queue, then DID, then extension; no match is the neutral fallback. */
export function pickServiceLabel(
  call: Pick<FinishedCall, 'queue' | 'did' | 'agentExtension'>,
  map: readonly ServiceMapRow[]
): string {
  const probe: [ServiceMatchType, string | null | undefined][] = [
    ['queue', call.queue],
    ['did', call.did],
    ['extension', call.agentExtension],
  ];
  for (const [type, value] of probe) {
    const v = value?.trim();
    if (!v) continue;
    const hit = map.find((m) => m.matchType === type && m.matchValue === v);
    const label = hit?.label.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (label) return label;
  }
  return SERVICE_FALLBACK;
}

/**
 * The call's own rules, in SPEC 028's order, before any lookup. Null
 * means it qualifies so far: the number is usable and a contact is next.
 */
export function qualifyCall(
  call: FinishedCall,
  s: ServiceDetailsSettings
): Exclude<ServiceDetailsOutcome, 'sent'> | { phone: string } {
  if (!call.answered) return 'not_answered';
  if (!call.agentExtension || !call.agentKnown) return 'no_agent';
  if (!(call.talkSeconds >= s.minSeconds)) return 'too_short';
  if (call.direction === 'internal') return 'direction_off';
  if (!(call.direction === 'inbound' ? s.inbound : s.outbound))
    return 'direction_off';
  const phone = toE164(call.customerNumber);
  return phone ? { phone } : 'bad_number';
}

export interface ContactHit {
  id: string;
  name: string | null;
  optedOutAt: string | null;
  doNotContactAt: string | null;
}

export interface ServiceDetailsPorts {
  loadSettings(accountId: string): Promise<ServiceDetailsSettings>;
  loadMap(accountId: string): Promise<ServiceMapRow[]>;
  /** The account's contacts on this number (storedPhoneCandidates). */
  findContacts(accountId: string, phone: string): Promise<ContactHit[]>;
  /**
   * pbx_service_details_claim: records the outcome once per call; true
   * 'claimed' only for the first claim of a call. 'sending' also takes
   * the shared daily cap slot (327) in the same statement, or records
   * 'daily_cap' and answers it.
   */
  claim(
    call: FinishedCall,
    outcome: ServiceDetailsOutcome | 'sending',
    contactId: string | null
  ): Promise<'claimed' | 'duplicate' | 'daily_cap'>;
  send(args: {
    accountId: string;
    contactId: string;
    phone: string;
    templateName: string;
    language: string | null;
    params: [string, string];
  }): Promise<boolean>;
  settle(call: FinishedCall, outcome: 'sent' | 'send_failed'): Promise<void>;
}

/**
 * Runs after the call end is durably recorded. Never throws: the PBX
 * webhook's answer never depends on it.
 */
export async function runServiceDetails(
  ports: ServiceDetailsPorts,
  call: FinishedCall
): Promise<ServiceDetailsOutcome> {
  let contactId: string | null = null;
  const record = async (o: ServiceDetailsOutcome) =>
    (await ports.claim(call, o, contactId)) === 'claimed' ? o : 'duplicate';
  try {
    const s = await ports.loadSettings(call.accountId);
    const q = qualifyCall(call, s);
    if (typeof q === 'string') return await record(q);
    const hits = await ports.findContacts(call.accountId, q.phone);
    if (!hits.length) return await record('no_contact');
    if (hits.length > 1) return await record('ambiguous_contact');
    const c = hits[0];
    contactId = c.id;
    if (c.optedOutAt || c.doNotContactAt) return await record('opted_out');
    if (!s.enabled) return await record('switched_off');
    if (!s.templateName) return await record('no_template');
    const label = pickServiceLabel(call, await ports.loadMap(call.accountId));
    // The claim is the once-per-call gate and the cap slot: nothing goes
    // to the gateway unless this call's first claim took it.
    const slot = await ports.claim(call, 'sending', c.id);
    if (slot !== 'claimed') return slot;
    const ok = await ports.send({
      accountId: call.accountId,
      contactId: c.id,
      phone: q.phone,
      templateName: s.templateName,
      language: s.language,
      params: [c.name?.trim() || '', label],
    });
    await ports.settle(call, ok ? 'sent' : 'send_failed');
    return ok ? 'sent' : 'send_failed';
  } catch (err) {
    console.error(
      `[pbx] call ${call.callRowId}: service details: ${err instanceof Error ? err.message : String(err)}`
    );
    return 'error';
  }
}
