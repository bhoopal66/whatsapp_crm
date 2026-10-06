// ============================================================
// Configuration — read once at startup from the environment.
//
// The server needs the URL of a Taamul Connect instance and an
// API key.
// Two opt-in flags decide whether write / broadcast tools are
// registered at all: by default the server is READ-ONLY, so an
// MCP client can never see a tool that mutates data or sends a
// message unless the operator turns it on deliberately. The API
// key's own scopes are still enforced server-side on top of this —
// this is a second, client-side guard, not a replacement.
//
// Every setting reads TAAMUL_* first and falls back to the
// pre-rebrand WACRM_* name. An MCP client config lives in the user's
// editor or desktop app, not in this repo, so dropping the old names
// would break every install on upgrade with a "missing environment
// variable" error and no hint that a rename caused it.
// ============================================================

export interface Config {
  baseUrl: string;
  apiKey: string;
  enableWrites: boolean;
  enableBroadcasts: boolean;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Read `TAAMUL_<name>`, falling back to the pre-rebrand
 * `WACRM_<name>`. Returns the trimmed value, or undefined if neither
 * is set.
 */
function env(name: string): string | undefined {
  return (
    process.env[`TAAMUL_${name}`]?.trim() ||
    process.env[`WACRM_${name}`]?.trim() ||
    undefined
  );
}

export function loadConfig(): Config {
  const baseUrlRaw = env('BASE_URL');
  const apiKey = env('API_KEY');

  const missing: string[] = [];
  if (!baseUrlRaw) missing.push('TAAMUL_BASE_URL');
  if (!apiKey) missing.push('TAAMUL_API_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set TAAMUL_BASE_URL to your instance URL (e.g. https://crm.example.com) ` +
        `and TAAMUL_API_KEY to a key from Settings → API keys.`,
    );
  }

  // Normalise: strip a trailing slash so path joins are predictable.
  const baseUrl = baseUrlRaw!.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(
      `TAAMUL_BASE_URL must start with http:// or https:// (got "${baseUrl}").`,
    );
  }

  const enableWrites = truthy(env('ENABLE_WRITES'));
  const enableBroadcasts = truthy(env('ENABLE_BROADCASTS'));

  if (enableBroadcasts && !enableWrites) {
    throw new Error(
      'TAAMUL_ENABLE_BROADCASTS requires TAAMUL_ENABLE_WRITES to also be set.',
    );
  }

  return {
    baseUrl,
    apiKey: apiKey!,
    enableWrites,
    enableBroadcasts,
  };
}
