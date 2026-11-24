import { afterEach, describe, expect, it, vi } from "vitest";

// getCurrentAccount resolves the caller's account context. The
// regression this file guards (issue #294): account loading must NOT
// depend on a PostgREST embedded FK join (`accounts!inner`), because a
// stale schema cache makes that embed fail hard and blanks the whole
// context. It must instead read the profile and then the account with
// two plain point queries.

// ------------------------------------------------------------
// Chainable Supabase query-builder mock. Each `.from(table)` hands back
// a thenable builder pre-loaded with the result queued for that table,
// so we can assert which tables were queried and with what filters.
// ------------------------------------------------------------
interface BuilderCall {
  table: string;
  columns?: string;
  eqArgs: [string, unknown][];
}

function makeClient(opts: {
  user: { id: string } | null;
  userErr?: unknown;
  byTable: Record<string, { data: unknown; error: unknown }>;
}) {
  const calls: BuilderCall[] = [];

  const from = (table: string) => {
    const call: BuilderCall = { table, eqArgs: [] };
    calls.push(call);
    const builder = {
      select(columns: string) {
        call.columns = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        call.eqArgs.push([col, val]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        );
      },
      // The profiles read is awaited as a list (one row per workspace).
      then(resolve: (r: unknown) => unknown) {
        return Promise.resolve(
          opts.byTable[table] ?? { data: null, error: null },
        ).then(resolve);
      },
    };
    return builder;
  };

  return {
    calls,
    client: {
      auth: {
        getUser: () =>
          Promise.resolve({
            data: { user: opts.user },
            error: opts.userErr ?? null,
          }),
      },
      from,
    },
  };
}

const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClient(),
}));

const {
  getCurrentAccount,
  requireSalesAccess,
  toErrorResponse,
  UnauthorizedError,
  ForbiddenError,
} = await import("./account");

// Departments (migration 192): one agent/admin row with a department,
// and `department_restricted()` answering `rpc`.
function departmentClient(
  profile: Record<string, unknown>,
  rpcResult: { data: unknown; error: unknown },
) {
  const { client } = makeClient({
    user: { id: "user-1" },
    byTable: {
      profiles: {
        data: [{ account_id: "acct-1", ...profile }],
        error: null,
      },
      accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
    },
  });
  const rpc = vi.fn(() => Promise.resolve(rpcResult));
  createClient.mockReturnValue({ ...client, rpc });
  return rpc;
}

describe("getCurrentAccount — departments (192)", () => {
  it("marks an HR agent restricted when the account says so", async () => {
    const rpc = departmentClient(
      { account_role: "agent", department: "hr" },
      { data: true, error: null },
    );
    const ctx = await getCurrentAccount();
    expect(ctx).toMatchObject({ department: "hr", salesRestricted: true });
    expect(rpc).toHaveBeenCalledWith("department_restricted", {
      p_account: "acct-1",
      p_department: "hr",
    });
  });

  it("never restricts an admin, and does not ask", async () => {
    const rpc = departmentClient(
      { account_role: "admin", department: "hr" },
      { data: true, error: null },
    );
    const ctx = await getCurrentAccount();
    expect(ctx).toMatchObject({ department: "hr", salesRestricted: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads a profile without the column (192 not applied) as unrestricted sales", async () => {
    const rpc = departmentClient(
      { account_role: "agent" },
      { data: true, error: null },
    );
    const ctx = await getCurrentAccount();
    expect(ctx).toMatchObject({ department: "sales", salesRestricted: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails open when the function is missing", async () => {
    departmentClient(
      { account_role: "agent", department: "hr" },
      { data: null, error: { code: "PGRST202", message: "not found" } },
    );
    const ctx = await getCurrentAccount();
    expect(ctx.salesRestricted).toBe(false);
  });

  it("requireSalesAccess answers a restricted caller 403", async () => {
    departmentClient(
      { account_role: "team_leader", department: "hr" },
      { data: true, error: null },
    );
    const err = await requireSalesAccess().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(toErrorResponse(err).status).toBe(403);
  });

  it("requireSalesAccess lets an unrestricted caller through", async () => {
    departmentClient(
      { account_role: "agent", department: "sales" },
      { data: false, error: null },
    );
    await expect(requireSalesAccess()).resolves.toMatchObject({
      salesRestricted: false,
    });
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCurrentAccount", () => {
  it("resolves context via a plain accounts lookup, not an embedded join", async () => {
    const { client, calls } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: [{ account_id: "acct-1", account_role: "owner" }],
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({
      userId: "user-1",
      accountId: "acct-1",
      role: "owner",
      account: { id: "acct-1", name: "Acme" },
    });

    // Two queries: profiles by user_id, then accounts by id. Neither
    // selects an embedded relationship — the regression guard.
    expect(calls.map((c) => c.table)).toEqual(["profiles", "accounts"]);
    expect(calls[0].columns).not.toMatch(/accounts!/);
    expect(calls[0].eqArgs).toEqual([["user_id", "user-1"]]);
    expect(calls[1].columns).not.toMatch(/accounts!/);
    expect(calls[1].eqArgs).toEqual([["id", "acct-1"]]);
  });

  it("takes the active workspace's row when the person has several (083)", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: [
            { account_id: "acct-0", account_role: "owner", is_active: false },
            { account_id: "acct-1", account_role: "agent", is_active: true },
          ],
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    const ctx = await getCurrentAccount();

    expect(ctx).toMatchObject({ accountId: "acct-1", role: "agent" });
  });

  it("still resolves on a database without is_active (083 not applied)", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: [{ account_id: "acct-1", account_role: "owner" }],
          error: null,
        },
        accounts: { data: { id: "acct-1", name: "Acme" }, error: null },
      },
    });
    createClient.mockReturnValue(client);

    await expect(getCurrentAccount()).resolves.toMatchObject({
      accountId: "acct-1",
    });
  });

  it("throws UnauthorizedError when there is no session", async () => {
    const { client } = makeClient({ user: null, byTable: {} });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("answers an auth outage 503, and a real refusal 401", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const statusFor = async (userErr: unknown) => {
      createClient.mockReturnValue(
        makeClient({ user: null, userErr, byTable: {} }).client,
      );
      return toErrorResponse(await getCurrentAccount().catch((e) => e)).status;
    };
    expect(
      await statusFor({ name: "AuthRetryableFetchError", status: 0 }),
    ).toBe(503);
    expect(await statusFor({ name: "AuthApiError", status: 500 })).toBe(503);
    for (const status of [400, 401, 403]) {
      expect(await statusFor({ name: "AuthApiError", status })).toBe(401);
    }
  });

  it("answers a failed profile read 503, but no profile 403", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const statusFor = async (profiles: { data: unknown; error: unknown }) => {
      createClient.mockReturnValue(
        makeClient({ user: { id: "user-1" }, byTable: { profiles } }).client,
      );
      return toErrorResponse(await getCurrentAccount().catch((e) => e)).status;
    };
    expect(await statusFor({ data: null, error: { code: "57014" } })).toBe(503);
    expect(await statusFor({ data: [], error: null })).toBe(403);
  });

  it("maps a profiles query error to 'Could not load account context'", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Could not load account context",
    );
  });

  it("maps an accounts query error to 'Could not load account context'", async () => {
    // The exact #294 shape if the embed were still in play, but now on
    // the decoupled accounts lookup: profile resolves, account read errors.
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: [{ account_id: "acct-1", account_role: "admin" }],
          error: null,
        },
        accounts: { data: null, error: { code: "PGRST200" } },
      },
    });
    createClient.mockReturnValue(client);
    const err = await getCurrentAccount().catch((e) => e);
    expect(err).not.toBeInstanceOf(ForbiddenError);
    expect(toErrorResponse(err).status).toBe(503);
    expect(err.message).toBe("Could not load account context");
  });

  it("rejects a profile not linked to an account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: { data: [{ account_id: null, account_role: null }], error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });

  it("rejects an account_id that resolves to no readable account", async () => {
    const { client } = makeClient({
      user: { id: "user-1" },
      byTable: {
        profiles: {
          data: [{ account_id: "acct-1", account_role: "viewer" }],
          error: null,
        },
        accounts: { data: null, error: null },
      },
    });
    createClient.mockReturnValue(client);
    await expect(getCurrentAccount()).rejects.toThrow(
      "Profile is not linked to an account",
    );
  });
});
