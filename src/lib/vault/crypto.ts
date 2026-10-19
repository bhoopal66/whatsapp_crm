/**
 * Ported from wacrm module 019c (vault), reference package 2026-10-18.
 * `workspace` / `workspaceId` parameters keep the reference names but mean the wacrm account id (accounts.id).
 * Vault crypto (the vault database store persists only what this module produces).
 *   encrypt / decrypt  AES-256-GCM (node:crypto). A fresh random 12-byte iv per call, a 16-byte tag. The AAD binds the
 *       ciphertext to its workspace, kind and blind index (vaultAad: 'workspace_id|kind|blind_index', token-independent),
 *       so a payload copied to another workspace's or kind's row, or to another item of the same workspace and kind,
 *       fails authentication. Keys come from a KeyProvider by key id and must be exactly 32 bytes.
 *   normalise(kind, value)  the canonical form that is encrypted and blind-indexed (so the same identifier written two
 *       ways dedupes onto one item). Throws VaultInputError naming the kind only. An ACCOUNT or PHONE whose digits (as
 *       given, or as normalised) are 13-19 long and Luhn-valid is refused: it may be a card number (PCI-DSS).
 *   blindIndex(workspace, kind, normalised, blindKey)  HMAC-SHA256 hex of workspace + '|' + kind + '|' + normalised under a
 *       separate key (>= 32 bytes); the workspace is in the input so one value has a different index in every workspace.
 * Errors never carry a plaintext, a key or an underlying library message: VaultCryptoError / VaultInputError have fixed
 * generic messages and no cause.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { luhnValid } from '@/lib/memory/redact';

export type VaultKind =
  'EID' | 'IBAN' | 'PASSPORT' | 'PHONE' | 'ACCOUNT' | 'TRADE_LICENCE';
export const VAULT_KINDS: readonly VaultKind[] = [
  'EID',
  'IBAN',
  'PASSPORT',
  'PHONE',
  'ACCOUNT',
  'TRADE_LICENCE',
];

export interface KeyProvider {
  /** Key id new ciphertexts are written under (vault_items.key_id: ^[A-Za-z0-9._:-]{1,64}$). */
  currentKeyId(): string;
  /** The 32-byte key for keyId; may throw for an unknown id. */
  getKey(keyId: string): Buffer;
}

export interface EncryptedPayload {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly keyId: string;
}

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const MIN_BLIND_KEY_BYTES = 32;
/** vault_items_payload: octet_length(ciphertext) between 1 and 4096 (GCM ciphertext length = plaintext length). */
export const MAX_PLAINTEXT_BYTES = 4096;

export class VaultCryptoError extends Error {
  override readonly name = 'VaultCryptoError';
}
export class VaultInputError extends Error {
  override readonly name = 'VaultInputError';
}

const ALGO = 'aes-256-gcm';

/**
 * AAD for an item: workspace, kind and blind index. The blind index is computed before encryption, unique per live
 * value in (workspace, kind) and immutable (vault_items_guard), so it binds the ciphertext to its own item. Neither
 * kind (a fixed set) nor the hex index can contain '|', so the encoding is unambiguous.
 */
export function vaultAad(
  workspaceId: string,
  kind: VaultKind,
  blindIndex: string
): Buffer {
  return Buffer.from(`${workspaceId}|${kind}|${blindIndex}`, 'utf8');
}

function keyFor(provider: KeyProvider, keyId: string): Buffer {
  let key: unknown;
  try {
    key = provider.getKey(keyId);
  } catch {
    throw new VaultCryptoError('vault: key unavailable');
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES)
    throw new VaultCryptoError('vault: invalid key');
  return key;
}

export function encrypt(
  plain: string,
  provider: KeyProvider,
  aad: Buffer
): EncryptedPayload {
  const data = Buffer.from(plain, 'utf8');
  if (data.length < 1 || data.length > MAX_PLAINTEXT_BYTES)
    throw new VaultCryptoError('vault: plaintext size out of range');
  const keyId = provider.currentKeyId();
  const key = keyFor(provider, keyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyId };
}

/** Decrypts and authenticates (tag over ciphertext + aad). Any failure throws VaultCryptoError('vault: decrypt failed'). */
export function decrypt(
  payload: EncryptedPayload,
  provider: KeyProvider,
  aad: Buffer
): string {
  const key = keyFor(provider, payload.keyId);
  if (
    payload.iv.length !== IV_BYTES ||
    payload.tag.length !== TAG_BYTES ||
    payload.ciphertext.length < 1
  ) {
    throw new VaultCryptoError('vault: decrypt failed');
  }
  try {
    const decipher = createDecipheriv(ALGO, key, payload.iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(payload.tag);
    const out = Buffer.concat([
      decipher.update(payload.ciphertext),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch {
    throw new VaultCryptoError('vault: decrypt failed');
  }
}

// ---- normalisation --------------------------------------------------------------------------------------------------

/** NFKC (full-width forms), format characters (LRM / RLM / ZWJ ...) removed, Arabic-Indic digits folded to ASCII. */
function prep(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (c) =>
      String.fromCharCode(48 + (c.charCodeAt(0) & 0x0f))
    )
    .trim();
}

function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 ? String(code - 55) : ch;
    for (const d of digits) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function bad(kind: VaultKind): never {
  throw new VaultInputError(`vault: invalid ${kind}`);
}

/** 13-19 digits passing Luhn: a card number (PAN). PCI-DSS: never stored, even encrypted. */
function panLike(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

export function normalise(kind: VaultKind, value: string): string {
  if (typeof value !== 'string')
    throw new VaultInputError('vault: value must be a string');
  const s = prep(value);
  switch (kind) {
    case 'EID': {
      if (!/^[0-9\s./-]+$/.test(s)) bad(kind);
      const d = s.replace(/\D/g, '');
      return /^[0-9]{15}$/.test(d) ? d : bad(kind);
    }
    case 'IBAN': {
      const c = s.replace(/[\s-]/g, '');
      if (!/^[A-Za-z0-9]+$/.test(c)) bad(kind);
      const u = c.toUpperCase();
      if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(u) || !ibanValid(u))
        bad(kind);
      return u;
    }
    case 'PHONE': {
      if (!/^\+?[0-9\s().-]+$/.test(s)) bad(kind);
      let d = s.replace(/\D/g, '');
      const international = s.startsWith('+') || d.startsWith('00');
      if (d.startsWith('00')) d = d.slice(2);
      // UAE national forms: mobile 05x xxx xxxx, landline 0[2-4,6,7,9] xxx xxxx -> 971 + number without the trunk 0.
      if (!international && /^0(5[0-9]{8}|[234679][0-9]{7})$/.test(d))
        d = '971' + d.slice(1);
      // +971 (0)5x ... : the trunk 0 after the UAE country code is dropped.
      if (d.startsWith('9710')) d = '971' + d.slice(4);
      if (panLike(s.replace(/\D/g, '')) || panLike(d)) bad(kind);
      return /^[1-9][0-9]{7,14}$/.test(d) ? d : bad(kind);
    }
    case 'PASSPORT': {
      const c = s.replace(/[\s-]/g, '');
      return /^[A-Za-z0-9]{6,9}$/.test(c) ? c.toUpperCase() : bad(kind);
    }
    case 'ACCOUNT': {
      if (!/^[0-9\s.-]+$/.test(s)) bad(kind);
      const d = s.replace(/\D/g, '');
      if (panLike(d)) bad(kind);
      return /^[0-9]{6,20}$/.test(d) ? d : bad(kind);
    }
    case 'TRADE_LICENCE': {
      const c = s.replace(/\s/g, '');
      return /^[A-Za-z0-9/-]{1,64}$/.test(c) && /[A-Za-z0-9]/.test(c)
        ? c.toUpperCase()
        : bad(kind);
    }
    default:
      throw new VaultInputError('vault: unsupported kind');
  }
}

export function blindIndex(
  workspace: string,
  kind: VaultKind,
  normalised: string,
  blindKey: Buffer
): string {
  if (!Buffer.isBuffer(blindKey) || blindKey.length < MIN_BLIND_KEY_BYTES)
    throw new VaultCryptoError('vault: invalid blind key');
  return createHmac('sha256', blindKey)
    .update(`${workspace}|${kind}|${normalised}`, 'utf8')
    .digest('hex');
}
