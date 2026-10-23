import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    logInserts: [] as Record<string, unknown>[],
    logUpdates: [] as Record<string, unknown>[],
    dealInserts: [] as Record<string, unknown>[],
    rpcCalls: [] as { fn: string; params: unknown }[],
    // resolve_chat_deal_owner's answer, and the profiles it maps to.
    dealOwnerRpc: { data: null, error: null } as { data: unknown; error: unknown },
    profiles: [] as { id: string; user_id: string; account_id: string }[],
    // chat_channels rows, and chat_post_system_message's answer.
    chatChannels: [] as Record<string, unknown>[],
    chatPostRpc: { data: "msg-1", error: null } as { data: unknown; error: unknown },
    // chat_channels_with_guests' answer: the channels that have a bank guest.
    chatGuestRpc: { data: [], error: null } as { data: unknown; error: unknown },
    // conversations lookup: rows keyed by id, each with its owner.
    conversations: [] as {
      id: string;
      account_id: string;
      contact_id: string;
      chat_tag_id?: string | null;
      chat_sub_tag_id?: string | null;
    }[],
  },
  writeChatTags: vi.fn(),
}));

// Rows match an eq() filter only on the keys they carry, so fixtures
// that leave a column out keep matching every query.
function matchesEq(row: Record<string, unknown>, filters: [string, string, unknown][]) {
  return filters.every(([op, k, v]) => op !== "eq" || !(k in row) || row[k] === v);
}

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "automations") {
      return {
        data: state.automations.filter((a) => matchesEq(a, ops.filters)),
        error: null,
      };
    }
    if (table === "automation_logs") {
      if (type === "insert") {
        state.logInserts.push(ops.payload as Record<string, unknown>);
        return { data: { id: "log1" }, error: null };
      }
      if (type === "update") {
        state.logUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") {
      return {
        data: state.steps.filter((st) => matchesEq(st, ops.filters)),
        error: null,
      };
    }
    if (table === "deals" && type === "insert") {
      state.dealInserts.push(ops.payload as Record<string, unknown>);
      return { data: null, error: null };
    }
    if (table === "chat_channels") {
      const row = state.chatChannels.find((c) => matchesEq(c, ops.filters));
      return { data: row ?? null, error: null };
    }
    if (table === "profiles") {
      const row = state.profiles.find((p) => matchesEq(p, ops.filters));
      return { data: row ?? null, error: null };
    }
    if (table === "conversations" && type === "select") {
      // Honour every eq() filter, like PostgREST would.
      const row = state.conversations.find((c) =>
        ops.filters.every(
          ([, k, v]) => (c as Record<string, unknown>)[k] === v
        )
      );
      return { data: row ?? null, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: (fn: string, params: unknown) => {
        state.rpcCalls.push({ fn, params });
        if (fn === "resolve_chat_deal_owner") {
          return Promise.resolve(state.dealOwnerRpc);
        }
        if (fn === "chat_post_system_message") {
          return Promise.resolve(state.chatPostRpc);
        }
        if (fn === "chat_channels_with_guests") {
          return Promise.resolve(state.chatGuestRpc);
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
});

vi.mock("@/lib/chat-tags/server", () => ({
  writeConversationChatTags: h.writeChatTags,
}));

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

// The real SSRF guard decides; only the transport is watched.
vi.mock("@/lib/webhooks/ssrf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks/ssrf")>()),
  safeFetch: vi.fn(async () => new Response(null, { status: 200 })),
}));

import {
  resolveConversationId,
  runAutomationsForTrigger,
  triggerMatches,
} from "./engine";
import { safeFetch } from "@/lib/webhooks/ssrf";
import type { Automation, KeywordMatchTriggerConfig } from "@/types";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.writeChatTags.mockReset();
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
  h.state.conversations = [];
  h.state.dealInserts = [];
  h.state.rpcCalls = [];
  h.state.dealOwnerRpc = { data: null, error: null };
  h.state.profiles = [];
  h.state.chatChannels = [];
  h.state.chatPostRpc = { data: "msg-1", error: null };
  h.state.chatGuestRpc = { data: [], error: null };
});

describe("resolveConversationId — context.conversation_id is not trusted", () => {
  const automation = { account_id: ACCOUNT } as Automation;
  const base = { automation, contactId: "c1", triggerEvent: "new_message_received" };

  it("uses the context id when it belongs to this account and contact", async () => {
    h.state.conversations = [
      { id: "conv-own", account_id: ACCOUNT, contact_id: "c1" },
    ];
    await expect(
      resolveConversationId({ ...base, context: { conversation_id: "conv-own" } })
    ).resolves.toBe("conv-own");
  });

  it("ignores another tenant's conversation id and falls back to the contact's own", async () => {
    h.state.conversations = [
      { id: "conv-victim", account_id: "acct-other", contact_id: "victim" },
      { id: "conv-own", account_id: ACCOUNT, contact_id: "c1" },
    ];
    await expect(
      resolveConversationId({ ...base, context: { conversation_id: "conv-victim" } })
    ).resolves.toBe("conv-own");
  });

  it("ignores a same-account conversation that belongs to a different contact", async () => {
    h.state.conversations = [
      { id: "conv-other-contact", account_id: ACCOUNT, contact_id: "c2" },
    ];
    await expect(
      resolveConversationId({
        ...base,
        context: { conversation_id: "conv-other-contact" },
      })
    ).rejects.toThrow(/no existing conversation/);
  });
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("automation_logs — status is seeded pessimistically (issue #409)", () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: "failed",
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => "status" in u);
    expect(withStatus.at(-1)).toMatchObject({ status: "success" });
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe("create_deal — owned like a tagged chat's deal (080)", () => {
  function setup() {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: "s1",
        automation_id: "a1",
        step_type: "create_deal",
        position: 0,
        parent_step_id: null,
        step_config: { pipeline_id: "pl1", stage_id: "st1", title: "Deal" },
      },
    ];
    h.state.conversations = [
      { id: "cv1", account_id: ACCOUNT, contact_id: "c1" },
    ];
  }
  const run = () =>
    runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

  it("gives the deal to the chat's owner, assignee included", async () => {
    setup();
    h.state.dealOwnerRpc = { data: "agent-user", error: null };
    h.state.profiles = [
      { id: "agent-profile", user_id: "agent-user", account_id: ACCOUNT },
    ];

    await run();

    expect(h.state.rpcCalls).toContainEqual({
      fn: "resolve_chat_deal_owner",
      params: { p_conversation_id: "cv1", p_actor: null },
    });
    expect(h.state.dealInserts).toHaveLength(1);
    expect(h.state.dealInserts[0]).toMatchObject({
      account_id: ACCOUNT,
      contact_id: "c1",
      user_id: "agent-user",
      assigned_to: "agent-profile",
    });
  });

  it("keeps the automation's owner when the rpc fails", async () => {
    setup();
    h.state.dealOwnerRpc = {
      data: null,
      error: { message: "function resolve_chat_deal_owner does not exist" },
    };

    await run();

    expect(h.state.dealInserts).toHaveLength(1);
    expect(h.state.dealInserts[0].user_id).toBe("u1");
    expect(h.state.dealInserts[0]).not.toHaveProperty("assigned_to");
  });

  it("keeps the automation's owner when the chat's owner has no profile in this account", async () => {
    // e.g. the creator fallback after that person left: their only
    // profile now belongs to another account, and assigning it would
    // hand the deal to an outsider (or trip deals_assignee_guard).
    setup();
    h.state.dealOwnerRpc = { data: "left-user", error: null };
    h.state.profiles = [
      { id: "left-profile", user_id: "left-user", account_id: "other-account" },
    ];

    await run();

    expect(h.state.dealInserts).toHaveLength(1);
    expect(h.state.dealInserts[0].user_id).toBe("u1");
    expect(h.state.dealInserts[0]).not.toHaveProperty("assigned_to");
  });

  it("keeps the automation's owner when the contact has no chat", async () => {
    setup();
    h.state.conversations = [];
    h.state.dealOwnerRpc = { data: "agent-user", error: null };

    await run();

    expect(h.state.dealInserts).toHaveLength(1);
    expect(h.state.dealInserts[0].user_id).toBe("u1");
    expect(h.state.dealInserts[0]).not.toHaveProperty("assigned_to");
  });
});

describe("send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)", () => {
  it("refuses a private / link-local destination and never calls fetch", async () => {
    // The step sends through the guard's address-pinned safeFetch; the
    // global fetch is watched too, so neither path may leave the box.
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(safeFetch).mockClear();

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep("http://169.254.169.254/latest/meta-data/")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain("automation_steps");
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "send_webhook",
    position: 0,
    parent_step_id: null,
    step_config: { url, headers: { "Metadata-Flavor": "Google" }, body_template: "{}" },
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe("triggerMatches — interactive_reply", () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "menu step",
      trigger_type: "interactive_reply",
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches when the tapped id is in reply_ids (exact)", () => {
    expect(
      triggerMatches(automation(["yes", "no"]), { interactive_reply_id: "yes" }),
    ).toBe(true);
  });

  it("does not match a different id", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "maybe" }),
    ).toBe(false);
  });

  it("does not match on a substring (exact only)", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "yes_please" }),
    ).toBe(false);
  });

  it("does not match when no reply id is present or config is empty", () => {
    expect(triggerMatches(automation(["yes"]), {})).toBe(false);
    expect(triggerMatches(automation([]), { interactive_reply_id: "yes" })).toBe(false);
  });
});

function chatTagAutomation(
  id: string,
  trigger: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    account_id: ACCOUNT,
    user_id: "u1",
    name: id,
    trigger_type: "chat_tag_set",
    trigger_config: trigger,
    is_active: true,
  };
}

function setChatTagStep(automationId: string, config: Record<string, unknown>) {
  return {
    id: `step-${automationId}`,
    automation_id: automationId,
    step_type: "set_chat_tag",
    position: 0,
    parent_step_id: null,
    step_config: config,
  };
}

function writeResult(
  previous: [string | null, string | null],
  saved: [string | null, string | null],
) {
  return {
    ok: true,
    conversationId: "conv-1",
    contactId: "c1",
    previous: { chat_tag_id: previous[0], chat_sub_tag_id: previous[1] },
    saved: { chat_tag_id: saved[0], chat_sub_tag_id: saved[1] },
  };
}

function conditionStep(config: Record<string, unknown>) {
  return {
    id: "cond",
    automation_id: "a1",
    step_type: "condition",
    position: 0,
    parent_step_id: null,
    step_config: config,
  };
}

/** The branch the run's condition step recorded (`branch=yes|no`). */
function branchTaken(): string | undefined {
  for (const u of h.state.logUpdates) {
    const steps = (u.steps_executed ?? []) as { step_type: string; detail?: string }[];
    const cond = steps.find((st) => st.step_type === "condition");
    if (cond?.detail) return cond.detail.replace("branch=", "");
  }
  return undefined;
}

describe("triggerMatches — chat_tag_set", () => {
  const onMain = chatTagAutomation("a1", {
    chat_tag_id: "interested",
  }) as unknown as Automation;
  const onPair = chatTagAutomation("a1", {
    chat_tag_id: "interested",
    chat_sub_tag_id: "adcb",
  }) as unknown as Automation;

  it("fires when the chat arrives at the main tag", () => {
    expect(
      triggerMatches(onMain, {
        previous_chat_tag_id: "new",
        previous_chat_sub_tag_id: null,
        chat_tag_id: "interested",
        chat_sub_tag_id: null,
      }),
    ).toBe(true);
  });

  it("does not fire while the chat merely stays on the tag", () => {
    // Picking a sub-tag under the main tag the chat already carries.
    expect(
      triggerMatches(onMain, {
        previous_chat_tag_id: "interested",
        previous_chat_sub_tag_id: null,
        chat_tag_id: "interested",
        chat_sub_tag_id: "adcb",
      }),
    ).toBe(false);
    // A re-save.
    expect(
      triggerMatches(onMain, {
        previous_chat_tag_id: "interested",
        chat_tag_id: "interested",
      }),
    ).toBe(false);
  });

  it("with a sub-tag, fires only on arrival at that pair", () => {
    expect(
      triggerMatches(onPair, {
        previous_chat_tag_id: "interested",
        previous_chat_sub_tag_id: null,
        chat_tag_id: "interested",
        chat_sub_tag_id: "adcb",
      }),
    ).toBe(true);
    expect(
      triggerMatches(onPair, {
        previous_chat_tag_id: "new",
        chat_tag_id: "interested",
        chat_sub_tag_id: "other",
      }),
    ).toBe(false);
  });

  it("fails closed with no configured tag or no event", () => {
    const blank = chatTagAutomation("a1", {}) as unknown as Automation;
    expect(triggerMatches(blank, { chat_tag_id: "interested" })).toBe(false);
    expect(triggerMatches(onMain, undefined)).toBe(false);
  });
});

describe("set_chat_tag", () => {
  it("writes the chat's tags and dispatches chat_tag_set once", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [
      { ...automationWithUpdateStep(), id: "setter" },
      chatTagAutomation("listener", { chat_tag_id: "interested" }),
    ];
    h.state.steps = [
      setChatTagStep("setter", {
        chat_tag_id: "interested",
        chat_sub_tag_id: "adcb",
      }),
      {
        id: "s-listener",
        automation_id: "listener",
        step_type: "close_conversation",
        position: 0,
        parent_step_id: null,
        step_config: {},
      },
    ];
    h.writeChatTags.mockResolvedValue(
      writeResult([null, null], ["interested", "adcb"]),
    );

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.writeChatTags).toHaveBeenCalledTimes(1);
    expect(h.writeChatTags.mock.calls[0][1]).toEqual({
      accountId: ACCOUNT,
      contactId: "c1",
      next: { chat_tag_id: "interested", chat_sub_tag_id: "adcb" },
    });
    // Two runs: the setter, then the chat_tag_set listener, once.
    expect(
      h.state.logInserts.map((l) => [l.automation_id, l.trigger_event]),
    ).toEqual([
      ["setter", "new_message_received"],
      ["listener", "chat_tag_set"],
    ]);
  });

  it("clears both columns for No tag; an unchanged chat dispatches nothing", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [{ ...automationWithUpdateStep(), id: "setter" }];
    h.state.steps = [
      setChatTagStep("setter", { chat_tag_id: null, chat_sub_tag_id: "stale" }),
    ];
    h.writeChatTags.mockResolvedValue(writeResult([null, null], [null, null]));

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.writeChatTags.mock.calls[0][1].next).toEqual({
      chat_tag_id: null,
      chat_sub_tag_id: null,
    });
    expect(h.state.logInserts).toHaveLength(1);
  });

  // The writer resolves the sub-tag against the chat's current tags;
  // the real resolver stands in for it on a chat tagged interested · adcb.
  it.each([
    ["no sub-tag, same main tag: keeps the sub-tag", {}, "interested", "adcb"],
    ["an empty sub-tag counts as none", { chat_sub_tag_id: "" }, "interested", "adcb"],
    ["no sub-tag, another main tag: clears it", {}, "lead", null],
    ["an explicit null sub-tag clears it", { chat_sub_tag_id: null }, "interested", null],
    ["a sub-tag sets it", { chat_sub_tag_id: "fab" }, "interested", "fab"],
  ])("set_chat_tag: %s", async (_name, sub, main, savedSub) => {
    const { resolveChatTagsWrite } = await vi.importActual<
      typeof import("@/lib/chat-tags/server")
    >("@/lib/chat-tags/server");
    const previous = { chat_tag_id: "interested", chat_sub_tag_id: "adcb" };
    h.state.owned = { id: "c1" };
    h.state.automations = [{ ...automationWithUpdateStep(), id: "setter" }];
    h.state.steps = [setChatTagStep("setter", { chat_tag_id: main, ...sub })];
    h.writeChatTags.mockImplementation(
      async (_db: unknown, args: { next: Parameters<typeof resolveChatTagsWrite>[1] }) => ({
        ...writeResult(["interested", "adcb"], ["interested", "adcb"]),
        saved: resolveChatTagsWrite(previous, args.next),
      }),
    );

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.writeChatTags).toHaveBeenCalledTimes(1);
    expect(await h.writeChatTags.mock.results[0].value).toMatchObject({
      saved: { chat_tag_id: main, chat_sub_tag_id: savedSub },
    });
  });

  it("stops an A-to-B-to-A chain at depth 3", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.owned = { id: "c1" };
    h.state.automations = [
      chatTagAutomation("to-b", { chat_tag_id: "a" }),
      chatTagAutomation("to-a", { chat_tag_id: "b" }),
    ];
    h.state.steps = [
      setChatTagStep("to-b", { chat_tag_id: "b" }),
      setChatTagStep("to-a", { chat_tag_id: "a" }),
    ];
    // Each write moves the chat to the tag asked for. Past ten writes it
    // reports no change, so a missing cap fails here instead of hanging.
    let current: string | null = "a";
    h.writeChatTags.mockImplementation(
      async (_db: unknown, a: { next: { chat_tag_id: string | null } }) => {
        if (h.writeChatTags.mock.calls.length > 10) {
          return writeResult([current, null], [current, null]);
        }
        const previous = current;
        current = a.next.chat_tag_id;
        return writeResult([previous, null], [current, null]);
      },
    );

    // A person tagged the chat "a"; the route dispatched at depth 1.
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "chat_tag_set",
      contactId: "c1",
      context: {
        conversation_id: "conv-1",
        previous_chat_tag_id: null,
        chat_tag_id: "a",
        vars: { _chat_tag_chain_depth: 1 },
      },
    });

    // Runs at depth 1, 2 and 3 each write; the third does not dispatch.
    expect(h.writeChatTags).toHaveBeenCalledTimes(3);
    expect(h.state.logInserts.map((l) => l.automation_id)).toEqual([
      "to-b",
      "to-a",
      "to-b",
    ]);
    vi.restoreAllMocks();
  });

  it("records a failed step when the contact has no chat", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [{ ...automationWithUpdateStep(), id: "setter" }];
    h.state.steps = [setChatTagStep("setter", { chat_tag_id: "interested" })];
    h.writeChatTags.mockResolvedValue({ ok: false, reason: "not_found" });

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_message: "set_chat_tag: contact has no conversation",
      }),
    );
  });
});

describe("retired contact-tag members", () => {
  it("logs a legacy add_tag step as a no-op and runs the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      {
        id: "s0",
        automation_id: "a1",
        step_type: "add_tag",
        position: 0,
        parent_step_id: null,
        step_config: { tag_id: "tag-a" },
      },
      { ...updateStep(), position: 1 },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No contact-tag write, the next step still ran, the run succeeded.
    expect(h.state.fromCalls).not.toContain("contact_tags");
    expect(h.state.updateCalls).toHaveLength(1);
    const withStatus = h.state.logUpdates.filter((u) => "status" in u);
    expect(withStatus.at(-1)).toMatchObject({ status: "success" });
    expect(warn).toHaveBeenCalledWith(
      "[automations] skipping retired contact-tag step",
      expect.objectContaining({ stepType: "add_tag" }),
    );
    vi.restoreAllMocks();
  });

  it("evaluates a legacy tag_presence condition as false", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      conditionStep({ subject: "tag_presence", operand: "tag-a" }),
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).not.toContain("contact_tags");
    expect(branchTaken()).toBe("no");
    vi.restoreAllMocks();
  });
});

describe("condition — chat_tag_presence", () => {
  async function evaluate(chat: {
    chat_tag_id: string | null;
    chat_sub_tag_id: string | null;
  }) {
    h.state.owned = { id: "c1" };
    h.state.conversations = [
      { id: "conv-1", account_id: ACCOUNT, contact_id: "c1", ...chat },
    ];
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      conditionStep({ subject: "chat_tag_presence", operand: "interested" }),
    ];
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });
    return branchTaken();
  }

  it("is true when the tag is the chat's main tag", async () => {
    await expect(
      evaluate({ chat_tag_id: "interested", chat_sub_tag_id: null }),
    ).resolves.toBe("yes");
  });

  it("is true when the tag is the chat's sub-tag", async () => {
    await expect(
      evaluate({ chat_tag_id: "lead", chat_sub_tag_id: "interested" }),
    ).resolves.toBe("yes");
  });

  it("is false when the chat carries neither", async () => {
    await expect(
      evaluate({ chat_tag_id: "lead", chat_sub_tag_id: "cold" }),
    ).resolves.toBe("no");
  });

  it("is false for another account's chat", async () => {
    h.state.owned = { id: "c1" };
    h.state.conversations = [
      {
        id: "conv-x",
        account_id: "acct-other",
        contact_id: "c1",
        chat_tag_id: "interested",
        chat_sub_tag_id: null,
      },
    ];
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [
      conditionStep({ subject: "chat_tag_presence", operand: "interested" }),
    ];
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });
    expect(branchTaken()).toBe("no");
  });
});

describe("triggerMatches — keyword_match", () => {
  function automation(
    cfg: Partial<KeywordMatchTriggerConfig> & { keywords: string[] },
  ): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "kw",
      trigger_type: "keyword_match",
      trigger_config: { match_type: "contains", ...cfg },
      is_active: true,
    } as unknown as Automation;
  }

  const on = (a: Automation, text: string) =>
    triggerMatches(a, { message_text: text });

  it("keeps `contains` as a raw substring test", () => {
    // Issue #409 asked for this to become word-boundary matching. It
    // deliberately did NOT change: existing automations relying on
    // substring behaviour ("cat" firing on "category") must keep working,
    // and `contains` is the builder's default. `word` is the opt-in fix.
    expect(on(automation({ keywords: ["k"] }), "thanks")).toBe(true);
    expect(on(automation({ keywords: ["cat"] }), "category")).toBe(true);
  });

  it("`word` matches only standalone words", () => {
    const a = automation({ keywords: ["k"], match_type: "word" });
    expect(on(a, "thanks")).toBe(false);
    expect(on(a, "k")).toBe(true);
    expect(on(a, "press k to continue")).toBe(true);
    expect(on(a, "press K!")).toBe(true);
  });

  it("`word` respects punctuation and line edges around the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "word" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi!")).toBe(true);
    expect(on(a, "(hi)")).toBe(true);
    expect(on(a, "say hi.")).toBe(true);
    expect(on(a, "this")).toBe(false);
    expect(on(a, "hiya")).toBe(false);
  });

  it("`word` handles a keyword that itself carries punctuation", () => {
    // `\b` can't do this: /\bhi!\b/ demands a word char after the "!",
    // so it never matches. Hence the lookaround implementation.
    const a = automation({ keywords: ["hi!"], match_type: "word" });
    expect(on(a, "say hi!")).toBe(true);
    expect(on(a, "hi! there")).toBe(true);
  });

  it("`word` treats regex metacharacters in a keyword as literal", () => {
    // Account-supplied free text — an unescaped "(" would throw.
    const a = automation({ keywords: ["c++ (beginner)"], match_type: "word" });
    expect(on(a, "I want the c++ (beginner) course")).toBe(true);
    expect(on(a, "I want the cxx beginner course")).toBe(false);
    expect(() => on(automation({ keywords: ["("], match_type: "word" }), "(")).not.toThrow();
  });

  it("`word` is case-insensitive unless case_sensitive is set", () => {
    expect(on(automation({ keywords: ["Hi"], match_type: "word" }), "hi")).toBe(true);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "hi",
      ),
    ).toBe(false);
    expect(
      on(
        automation({ keywords: ["Hi"], match_type: "word", case_sensitive: true }),
        "Hi",
      ),
    ).toBe(true);
  });

  it("`word` finds a space-delimited keyword in a non-Latin script", () => {
    // ASCII `\b` fails outright here — every character of "안녕" is a
    // non-word character to it, so /\b안녕\b/ matches nothing.
    const a = automation({ keywords: ["안녕"], match_type: "word" });
    expect(on(a, "안녕")).toBe(true);
    expect(on(a, "저기 안녕 하세요")).toBe(true);
    // Documented limitation, not an accident: a language written without
    // spaces has no word edge inside a run of characters.
    expect(on(a, "안녕하세요")).toBe(false);
  });

  it("`exact` still requires the whole message to be the keyword", () => {
    const a = automation({ keywords: ["hi"], match_type: "exact" });
    expect(on(a, "hi")).toBe(true);
    expect(on(a, "hi there")).toBe(false);
  });

  it("ignores empty keywords and empty messages in `word` mode", () => {
    expect(on(automation({ keywords: [""], match_type: "word" }), "anything")).toBe(false);
    expect(on(automation({ keywords: ["hi"], match_type: "word" }), "")).toBe(false);
  });
});

describe("post_team_chat", () => {
  function poster(config: Record<string, unknown>) {
    h.state.automations = [{ ...automationWithUpdateStep(), id: "poster" }];
    h.state.steps = [
      {
        id: "step-poster",
        automation_id: "poster",
        step_type: "post_team_chat",
        position: 0,
        parent_step_id: null,
        step_config: config,
      },
    ];
  }
  const posts = () =>
    h.state.rpcCalls.filter((c) => c.fn === "chat_post_system_message");

  it("posts the interpolated text into the account's channel as the automation", async () => {
    poster({
      channel_id: "ch-team",
      text: "**New lead** wrote: {{ message.text }} ({{ vars.source }})",
    });
    h.state.chatChannels = [
      { id: "ch-team", account_id: ACCOUNT, kind: "team", archived_at: null },
    ];
    h.state.owned = { id: "c1" };
    h.state.conversations = [
      { id: "conv-1", account_id: ACCOUNT, contact_id: "c1" },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {
        message_text: "price?",
        vars: { source: "ads" },
        conversation_id: "conv-1",
      },
    });

    expect(posts()).toEqual([
      {
        fn: "chat_post_system_message",
        params: {
          p_channel: "ch-team",
          p_body: "**New lead** wrote: price? (ads)",
          // the trail back to whose words these are
          p_meta: {
            source: "automation",
            automation_id: "poster",
            conversation_id: "conv-1",
            contact_id: "c1",
          },
        },
      },
    ]);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "success" }),
    );
  });

  it("refuses a channel of another account and posts nothing", async () => {
    poster({ channel_id: "ch-foreign", text: "hello" });
    h.state.chatChannels = [
      { id: "ch-foreign", account_id: "acct-2", kind: "team", archived_at: null },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      context: {},
    });

    expect(posts()).toEqual([]);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_message: "post_team_chat: channel not found in this workspace",
      }),
    );
  });

  it("refuses a DM of the account", async () => {
    poster({ channel_id: "ch-dm", text: "hello" });
    h.state.chatChannels = [
      { id: "ch-dm", account_id: ACCOUNT, kind: "dm", archived_at: null },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      context: {},
    });

    expect(posts()).toEqual([]);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_message: "post_team_chat: cannot post to a dm channel",
      }),
    );
  });

  it("records team chat being off as the step's failure", async () => {
    poster({ channel_id: "ch-team", text: "hello" });
    h.state.chatChannels = [
      { id: "ch-team", account_id: ACCOUNT, kind: "private", archived_at: null },
    ];
    h.state.chatPostRpc = {
      data: null,
      error: { code: "CH001", message: "internal chat is disabled" },
    };

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      context: {},
    });

    expect(posts()).toHaveLength(1);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_message: "post_team_chat: team chat is turned off for this workspace",
      }),
    );
  });

  const guestRefusal =
    "post_team_chat: the channel has a bank guest member, and customer text is never posted where a bank guest reads it";

  it("refuses a channel with a bank guest member and posts nothing", async () => {
    poster({ channel_id: "ch-priv", text: "{{ message.text }}" });
    h.state.chatChannels = [
      { id: "ch-priv", account_id: ACCOUNT, kind: "private", archived_at: null },
    ];
    h.state.chatGuestRpc = { data: ["ch-priv"], error: null };

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      context: { message_text: "my salary is 12,000" },
    });

    expect(h.state.rpcCalls).toContainEqual({
      fn: "chat_channels_with_guests",
      params: { p_channels: ["ch-priv"] },
    });
    expect(posts()).toEqual([]);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: guestRefusal }),
    );
  });

  it("refuses on the next run once a guest has joined the channel", async () => {
    poster({ channel_id: "ch-priv", text: "{{ message.text }}" });
    h.state.chatChannels = [
      { id: "ch-priv", account_id: ACCOUNT, kind: "private", archived_at: null },
    ];
    const run = () =>
      runAutomationsForTrigger({
        accountId: ACCOUNT,
        triggerType: "new_message_received",
        context: { message_text: "hello" },
      });

    await run();
    expect(posts()).toHaveLength(1);

    h.state.chatGuestRpc = { data: ["ch-priv"], error: null };
    await run();
    expect(posts()).toHaveLength(1);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({ status: "failed", error_message: guestRefusal }),
    );
  });

  it("fails closed when the bank guest check fails", async () => {
    poster({ channel_id: "ch-team", text: "hello" });
    h.state.chatChannels = [
      { id: "ch-team", account_id: ACCOUNT, kind: "team", archived_at: null },
    ];
    h.state.chatGuestRpc = { data: null, error: { message: "timeout" } };

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      context: {},
    });

    expect(posts()).toEqual([]);
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error_message: "post_team_chat: bank guest check failed: timeout",
      }),
    );
  });

  it("defuses bold and mentions in filled-in values, not in the automation's own text", async () => {
    poster({
      channel_id: "ch-team",
      text: "**Lead** said {{ message.text }} {{ vars.note }} **urgent**",
    });
    h.state.chatChannels = [
      { id: "ch-team", account_id: ACCOUNT, kind: "team", archived_at: null },
    ];
    const someone = "0b7e2d4c-1f3a-4e5b-8c9d-0a1b2c3d4e5f";

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      context: {
        message_text: `**FREE** <@${someone}> @here`,
        vars: { note: "**" },
      },
    });

    expect(posts()).toHaveLength(1);
    expect((posts()[0].params as { p_body: string }).p_body).toBe(
      `**Lead** said \u2217\u2217FREE\u2217\u2217 <\uFF20${someone}> \uFF20here \u2217\u2217 **urgent**`,
    );
  });
});
