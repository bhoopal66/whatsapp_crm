/**
 * Written for the wacrm port of module 019c (vault), reference package 2026-10-18; the reference has no key loader.
 * Vault key loader (new in wacrm; module 019c has no env contract of its own). Reads the vault's keys from the
 * environment at call time, never at module load, and never throws.
 *   VAULT_KEYS         comma-separated `id:base64` entries. id ^[A-Za-z0-9_-]{1,32}$, unique; the value is standard or
 *                      url-safe base64 (padding optional) decoding to exactly 32 bytes (AES-256). Keep every old key
 *                      that still has live items listed: decrypt looks a payload's key up by its recorded id.
 *   VAULT_CURRENT_KEY  the id new ciphertexts are written under; must be listed in VAULT_KEYS.
 *   VAULT_BLIND_KEY    base64 decoding to >= 32 bytes, byte-different from every encryption key. It keys the blind
 *                      index (HMAC-SHA256) and is NOT rotated with the encryption keys: changing it orphans every index.
 * A variable that is unset or blank counts as unset; all three unset is NOT_CONFIGURED (the vault is off). Reasons are
 * fixed strings, and nothing here logs or puts key material (or a key id) into a message.
 */
import {
  VaultCryptoError,
  KEY_BYTES,
  MIN_BLIND_KEY_BYTES,
  type KeyProvider,
} from './crypto';

export type VaultKeysResult =
  | {
      readonly ok: true;
      readonly keys: KeyProvider;
      readonly blindKey: Buffer;
      readonly keyIds: string[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'NOT_CONFIGURED'
        | 'INVALID_KEYS'
        | 'INVALID_CURRENT_KEY'
        | 'INVALID_BLIND_KEY';
    };

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const B64_STANDARD = /^[A-Za-z0-9+/]+={0,2}$/;
const B64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

function present(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Strict base64 (one alphabet, padding optional): the bytes, or null. Node's decoder silently skips characters it does
 * not know and truncates odd tails, so the value must round-trip to the same text (padding aside).
 */
function decodeBase64(text: string): Buffer | null {
  if (!B64_STANDARD.test(text) && !B64_URL.test(text)) return null;
  const bare = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (bare.length % 4 === 1) return null;
  if (/=/.test(text) && text.length % 4 !== 0) return null;
  const bytes = Buffer.from(bare, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== bare) return null;
  return bytes;
}

export function loadVaultKeys(
  env: Record<string, string | undefined> = process.env
): VaultKeysResult {
  try {
    const rawKeys = env.VAULT_KEYS;
    const rawCurrent = env.VAULT_CURRENT_KEY;
    const rawBlind = env.VAULT_BLIND_KEY;
    if (!present(rawKeys) && !present(rawCurrent) && !present(rawBlind)) {
      return { ok: false, reason: 'NOT_CONFIGURED' };
    }

    if (!present(rawKeys)) return { ok: false, reason: 'INVALID_KEYS' };
    const keys = new Map<string, Buffer>();
    for (const entry of rawKeys.split(',')) {
      const e = entry.trim();
      const colon = e.indexOf(':');
      if (colon < 0) return { ok: false, reason: 'INVALID_KEYS' };
      const id = e.slice(0, colon);
      const bytes = decodeBase64(e.slice(colon + 1));
      if (!KEY_ID.test(id) || keys.has(id)) {
        return { ok: false, reason: 'INVALID_KEYS' };
      }
      if (!bytes || bytes.length !== KEY_BYTES) {
        return { ok: false, reason: 'INVALID_KEYS' };
      }
      keys.set(id, bytes);
    }

    const current = present(rawCurrent) ? rawCurrent.trim() : '';
    if (!keys.has(current)) return { ok: false, reason: 'INVALID_CURRENT_KEY' };

    const blindKey = present(rawBlind) ? decodeBase64(rawBlind.trim()) : null;
    if (
      !blindKey ||
      blindKey.length < MIN_BLIND_KEY_BYTES ||
      [...keys.values()].some((k) => k.equals(blindKey))
    ) {
      return { ok: false, reason: 'INVALID_BLIND_KEY' };
    }

    const provider: KeyProvider = {
      currentKeyId: () => current,
      getKey: (keyId) => {
        const key = keys.get(keyId);
        if (!key) throw new VaultCryptoError('vault: unknown key id');
        return Buffer.from(key);
      },
    };
    return { ok: true, keys: provider, blindKey, keyIds: [...keys.keys()] };
  } catch {
    // Unreachable with string env values; kept so a hostile env object (a throwing getter) cannot make this throw.
    return { ok: false, reason: 'INVALID_KEYS' };
  }
}
