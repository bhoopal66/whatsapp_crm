"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  isBankGuest as isBankGuestRole,
  type AccountRole,
} from "@/lib/auth/roles";
import { pickActiveProfile } from "@/lib/auth/active-profile";
import {
  fallbackWorkspace,
  parseMyWorkspaces,
  workspaceEntryPath,
  workspaceHomePath,
  type Workspace,
} from "@/lib/auth/my-workspaces";
import { clearClientCache } from "@/lib/client-cache";
import { signOutReleasingPush } from "@/lib/push/sign-out";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
}

/**
 * Whether we managed to establish what this user may do.
 *
 * `unlinked` and `error` are the states worth surfacing: every RLS
 * policy checks `is_account_member(account_id, …)` and every `useCan`
 * gate returns false without a role, so in both the app silently
 * becomes read-only — the whole UI renders, and nothing saves. That is
 * indistinguishable from a bug unless we say so (issue #471).
 */
export type AccountStatus =
  /** Profile row still in flight. */
  | "loading"
  /** Account + role resolved; normal operation. */
  | "ready"
  /** Signed in, but no profile row / no account / no role on it. */
  | "unlinked"
  /** The profile lookup itself failed after retrying. */
  | "error";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /**
   * Outcome of resolving this user's account + role. Anything other
   * than `ready` means writes will be rejected — render
   * `<AccountAccessAlert />` (already mounted in the dashboard shell)
   * rather than letting the user discover it one failed save at a time.
   */
  accountStatus: AccountStatus;
  /** Underlying message when `accountStatus` is 'error' / 'unlinked'. */
  accountStatusDetail: string | null;
  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;

  // ----------------------------------------------------------
  // Workspaces (migration 083): one login, one profile row per
  // workspace (account), exactly one of them active.
  // ----------------------------------------------------------

  /** Every workspace the person belongs to, active first (my_workspaces()).
   *  Empty while loading, and on a database without migration 083. */
  workspaces: Workspace[];
  /** The workspace the app is working in — `accountId` once loaded. */
  activeWorkspaceId: string | null;
  /** True if the active role is `bank_guest`: team chat only. */
  isBankGuest: boolean;
  /**
   * Make `accountId` the active workspace, then reload the app there
   * (a hard navigation, so realtime channels and caches restart in the
   * new workspace): on `next` when it is an in-app path the person's
   * role there may open (`workspaceEntryPath`), else on its landing
   * page. Rejects with the server's reason when refused.
   */
  switchWorkspace: (accountId: string, next?: string) => Promise<void>;
  /**
   * Reload the app in the workspace the server has already made active
   * (archiving this one moves the caller out, migration 105), landing
   * as a switch does: caches dropped, other tabs told, `role`'s landing
   * page.
   */
  reloadIntoActiveWorkspace: (role: AccountRole | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Attempts at the profile lookup, including the first. */
const PROFILE_FETCH_ATTEMPTS = 2;
const PROFILE_FETCH_RETRY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shape of the `profiles` select below. */
interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[] | null;
  account_id: string | null;
  account_role: string | null;
  /** Migration 069. Absent on a database that predates it. */
  deactivated_at?: string | null;
  /** Migration 083. Absent on a database that predates it. */
  is_active?: boolean | null;
}

/** Other tabs of this browser follow a workspace switch (see below). */
const WORKSPACE_CHANNEL = "taamul-connect:workspace";

/**
 * Ask the server to move the caller's active workspace. Null on
 * success, else the reason. Never throws: the deactivation path below
 * must reach its own fallback whatever the network does.
 */
async function requestWorkspaceSwitch(
  accountId: string,
): Promise<string | null> {
  try {
    const res = await fetch("/api/workspaces/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    if (res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    const error =
      body && typeof body === "object" && "error" in body
        ? (body as { error: unknown }).error
        : null;
    return typeof error === "string" && error ? error : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : "network error";
  }
}

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  // Why the account/role couldn't be established, when it couldn't.
  // Null on the happy path.
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // Every switch lands here: drop what the old workspace cached, tell
  // this browser's other tabs (they share the active workspace, which
  // is a database flag, not per tab), and load the new workspace's
  // landing page from scratch, or `next` once `workspaceEntryPath` has
  // checked it is an in-app path that role may open. The other tabs
  // go to the landing page.
  const workspaceChannelRef = useRef<BroadcastChannel | null>(null);
  const enterWorkspace = useCallback(
    (role: AccountRole | null, next?: string) => {
      clearClientCache();
      try {
        workspaceChannelRef.current?.postMessage({ type: "switched", role });
      } catch {
        // Closed channel: the other tabs follow on their next load.
      }
      window.location.assign(workspaceEntryPath(role, next));
    },
    [],
  );

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    setStatusDetail(null);
    lastFetchedUserIdRef.current = userId;
    // Start the account read NOW, in parallel with the profile read
    // below, rather than after it. These are two sequential round trips
    // on the critical path of every full page load, and on a tunnelled
    // self-host each one costs ~700ms — the profile has to land before
    // any screen can decide what the user may do. `Promise.resolve`
    // is what starts it: a PostgREST builder sends nothing until its
    // `then` is called, so holding the bare builder ran it after the
    // profile read after all.
    //
    // No account id is needed to ask: `accounts_select` is
    // `USING (is_account_member(id))` (migration 017), so this returns
    // exactly the caller's own account. The result is still matched
    // against `profile.account_id` below and falls back to the point
    // lookup if it somehow disagrees, so the guarantee is unchanged.
    // Never rejects: a failure reads as null, handled at the point of use.
    const accountsRead = Promise.resolve(
      supabase.from("accounts").select("id, name, default_currency"),
    ).then(
      (r) => (r.error ? null : (r.data ?? [])),
      () => null,
    );
    // The person's workspaces (migration 083), for the switcher, for a
    // bank guest's account name (a guest cannot read `accounts`), and
    // for leaving a deactivated workspace. In parallel too; a failure
    // (a database without 083) reads as none.
    const workspacesRead = Promise.resolve(supabase.rpc("my_workspaces")).then(
      (r) => (r.error ? [] : parseMyWorkspaces(r.data)),
      () => [] as Workspace[],
    );
    // A switch navigates away; keep the loading state rather than flash
    // the error alert for the profile this tab is about to replace.
    let leaving = false;

    try {
      let data: ProfileRow | null = null;
      for (let attempt = 1; ; attempt++) {
        const result = await supabase
          .from("profiles")
          // `*`, not a column list: `deactivated_at` (migration 069)
          // and `is_active` (083) may not exist yet, and naming a
          // missing column fails the whole read — which locks every
          // user out of the UI.
          .select("*")
          // One row per workspace since 083 (RLS hands a person all of
          // their own), so not `.maybeSingle()`, which errors for anyone
          // in two workspaces: take the active row.
          .eq("user_id", userId);

        if (!result.error) {
          data = pickActiveProfile(result.data as ProfileRow[] | null);
          break;
        }

        const error = result.error;
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        // One hiccup here used to lock the session read-only for good:
        // the profile stayed null, so every `useCan` gate answered
        // false and no page offered a way to recover (issue #471).
        // Retry, then hand the reason to the UI.
        if (attempt < PROFILE_FETCH_ATTEMPTS) {
          await sleep(PROFILE_FETCH_RETRY_MS);
          continue;
        }
        lastFetchedUserIdRef.current = null;
        setStatusDetail(error.message);
        return;
      }

      const workspaceList = await workspacesRead;
      setWorkspaces(workspaceList);

      if (data?.deactivated_at) {
        // An admin deactivated this membership (migration 069) — since
        // 083 that is one workspace, not the login. If another of the
        // person's workspaces is still open, move there: signing them
        // out would only land them back here at the next sign-in, and
        // out again.
        const fallback = fallbackWorkspace(
          workspaceList,
          data.account_id ?? null,
        );
        if (fallback) {
          const failure = await requestWorkspaceSwitch(fallback.accountId);
          if (!failure) {
            leaving = true;
            enterWorkspace(fallback.role);
            return;
          }
          // Still signed in: their other workspace is open to them. The
          // access alert shows this with a Retry, and the switcher works.
          lastFetchedUserIdRef.current = null;
          setStatusDetail(
            `this workspace was deactivated; switching to ${fallback.name} failed: ${failure}`,
          );
          return;
        }
        // Every membership is deactivated, so the login is banned and
        // RLS already returns them nothing, but a tab opened earlier
        // still holds a session; end it rather than leave them on a
        // dashboard that silently shows nothing. The default (global)
        // sign-out also revokes their refresh tokens.
        // If the global sign-out is refused, still clear the local
        // session: the middleware bounces a signed-in visitor off
        // /login, which would otherwise loop back here.
        const { error: signOutError } = await signOutReleasingPush(() =>
          supabase.auth.signOut()
        ).catch((err: unknown) => ({ error: err }));
        if (signOutError) await supabase.auth.signOut({ scope: "local" });
        window.location.href = "/login?deactivated=1";
        return;
      }

      if (data) {
        // Narrow the DB enum into our AccountRole union. The DB
        // constraint should make this unconditional, but a future
        // migration that broadens the enum without updating TS would
        // otherwise crash here — fall back to null and let UI gates
        // treat the caller as least-privileged.
        const accountRole = isAccountRole(data.account_role)
          ? data.account_role
          : null;

        // Load the account with a plain lookup by id instead of an
        // embedded FK join. The embed (`account:accounts!inner(...)`)
        // forces PostgREST to resolve the profiles.account_id →
        // accounts.id relationship from its schema cache; a stale cache
        // (common right after a migration adds the FK) makes it fail
        // hard with PGRST200 and blanks the whole profile — the user
        // then loses account context everywhere (issue #294). A point
        // lookup by id needs no relationship inference, so the profile
        // (with account_id / account_role) still resolves even if the
        // account name lookup itself can't.
        let accountRow: AccountSummary | null = null;
        // A bank guest cannot read `accounts` (083): skip the point
        // lookup's round trip and name the account from the list below.
        if (data.account_id && !isBankGuestRole(accountRole)) {
          // The parallel read above has usually already landed. Take the
          // row matching this profile's account_id; anything else (an
          // error, or a set that somehow doesn't contain it) falls
          // through to the original point lookup.
          const parallel =
            (await accountsRead)?.find((a) => a.id === data!.account_id) ??
            null;

          const { data: account, error: accountErr } = parallel
            ? { data: parallel, error: null }
            : await supabase
                .from("accounts")
                // default_currency added in migration 021; narrowed to the
                // USD fallback below for older schemas where it reads null.
                .select("id, name, default_currency")
                .eq("id", data.account_id)
                .maybeSingle();
          if (accountErr) {
            console.error("[AuthProvider] fetchAccount error:", {
              message: accountErr.message,
              details: accountErr.details,
              hint: accountErr.hint,
              code: accountErr.code,
            });
          } else if (account) {
            accountRow = {
              id: account.id,
              name: account.name,
              default_currency: account.default_currency ?? DEFAULT_CURRENCY,
            };
          }
        }
        if (!accountRow && data.account_id) {
          // my_workspaces() names the account for anyone who cannot
          // read it: a bank guest, or a read that failed above.
          const entry = workspaceList.find(
            (w) => w.accountId === data!.account_id,
          );
          if (entry) {
            accountRow = {
              id: entry.accountId,
              name: entry.name,
              default_currency: DEFAULT_CURRENCY,
            };
          }
        }

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
        });
        setAccount(accountRow);
        if (!data.account_id || !accountRole) {
          // The row exists but carries no tenancy. Migration 017 made
          // both columns NOT NULL for new signups, so this is a user
          // whose bootstrap didn't complete (handle_new_user swallows a
          // failure as a WARNING) or one predating that migration.
          // Every insert and update they attempt will be denied by RLS.
          setStatusDetail(
            `profile ${data.id} has no ${!data.account_id ? "account_id" : "account_role"}`,
          );
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setStatusDetail("no profiles row for the signed-in user");
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
      setStatusDetail(err instanceof Error ? err.message : "profile fetch failed");
    } finally {
      if (!leaving) setProfileLoading(false);
    }
  }, [enterWorkspace]);

  // Another tab of this browser switched workspace: the database's
  // active workspace is now that one for this tab too, so follow it
  // rather than keep showing the old workspace over the new one's data.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(WORKSPACE_CHANNEL);
    workspaceChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      const role: unknown = (event.data as { role?: unknown } | null)?.role;
      clearClientCache();
      window.location.assign(
        workspaceHomePath(isAccountRole(role) ? role : null),
      );
    };
    return () => {
      workspaceChannelRef.current = null;
      channel.close();
    };
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setProfile(null);
        setAccount(null);
        setWorkspaces([]);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await signOutReleasingPush(() => supabase.auth.signOut());
    setUser(null);
    setProfile(null);
    setAccount(null);
    setWorkspaces([]);
    window.location.href = "/login";
  }, []);

  const switchWorkspace = useCallback(
    async (accountId: string, next?: string) => {
      const failure = await requestWorkspaceSwitch(accountId);
      if (failure) throw new Error(failure);
      const target = workspaces.find((w) => w.accountId === accountId);
      // Without the target's role (a stale list), `next` can't be vetted
      // for that role — a bank guest could be sent to the inbox — so
      // enter at the workspace's home instead.
      enterWorkspace(target?.role ?? null, target ? next : undefined);
    },
    [workspaces, enterWorkspace],
  );

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
      isBankGuest: isBankGuestRole(role),
    };
  }, [profile?.account_role, profile?.account_id]);

  const activeWorkspaceId =
    derived.accountId ??
    workspaces.find((w) => w.isActive)?.accountId ??
    null;

  // Signed out is not a broken account — the shell redirects to /login
  // before anything reads this.
  const accountStatus: AccountStatus = !user
    ? "loading"
    : profileLoading
      ? "loading"
      : !profile
        ? "error"
        : derived.accountId && derived.accountRole
          ? "ready"
          : "unlinked";

  // One stable object per actual change. A fresh literal here re-rendered
  // every `useAuth()` consumer (sidebar, header, every page) whenever the
  // provider rendered for any reason, even with nothing changed.
  const defaultCurrency = account?.default_currency ?? DEFAULT_CURRENCY;
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      loading,
      profileLoading,
      signOut,
      refreshProfile,
      account,
      defaultCurrency,
      accountStatus,
      accountStatusDetail: statusDetail,
      ...derived,
      workspaces,
      activeWorkspaceId,
      switchWorkspace,
      reloadIntoActiveWorkspace: enterWorkspace,
    }),
    [
      user,
      profile,
      loading,
      profileLoading,
      signOut,
      refreshProfile,
      account,
      defaultCurrency,
      accountStatus,
      statusDetail,
      derived,
      workspaces,
      activeWorkspaceId,
      switchWorkspace,
      enterWorkspace,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      // Outside the provider there is nothing to resolve yet — 'loading'
      // keeps the access alert from firing on, say, the login page.
      accountStatus: "loading",
      accountStatusDetail: null,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
      workspaces: [],
      activeWorkspaceId: null,
      isBankGuest: false,
      switchWorkspace: async () => {},
      reloadIntoActiveWorkspace: () => {},
    };
  }
  return ctx;
}
