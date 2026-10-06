import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Entry-trigger dispatch (issue #490).
//
// Drives the real `dispatchInboundToFlows` against a fake Supabase so
// the assertion is "a run was actually started", not "a helper returned
// true". The bug was that a button tap never reached the keyword
// matcher at all, so a helper-level test would have missed it.
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    /** Rows loadActiveRunForContact sees. Empty = no run in progress. */
    activeRuns: [] as unknown[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    updates: [] as { table: string; row: Record<string, unknown> }[],
    /** Set by the flow_runs INSERT; what its .maybeSingle() returns. */
    insertedRun: null as Record<string, unknown> | null,
    rpcCalls: [] as string[],
  },
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (row: Record<string, unknown>) => {
        h.state.updates.push({ table, row });
        return b;
      },
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === "flow_runs") {
          h.state.insertedRun = {
            id: "run-1",
            vars: {},
            reprompt_count: 0,
            ...row,
          };
        }
        return b;
      },
      // Only reached on the INSERT ... SELECT for a new run, and on
      // loadFlow's flows lookup.
      maybeSingle: async () => ({
        data:
          table === "flow_runs"
            ? h.state.insertedRun
            : (rows(table)[0] ?? null),
        error: null,
      }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: {
          data: unknown[];
          error: null;
          count: number;
        }) => unknown,
      ) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string) => {
        h.state.rpcCalls.push(name);
        return Promise.resolve({ error: null });
      },
    }),
  };
});

const engineSendText = vi.fn(async () => ({ whatsapp_message_id: "wamid.1" }));
const engineSendInteractiveButtons = vi.fn(async () => ({
  whatsapp_message_id: "wamid.3",
}));

vi.mock("./channel-send", () => ({
  engineSendText: (...a: unknown[]) =>
    (engineSendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: (...a: unknown[]) =>
    (engineSendInteractiveButtons as unknown as (...x: unknown[]) => unknown)(
      ...a,
    ),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: "wamid.4",
  })),
}));

// The AI agent, for the `ai` fallback (054). Outcome is set per test.
type AiOutcome = "replied" | "handed_off" | "skipped";
const aiReply = vi.fn<(args: unknown) => Promise<AiOutcome>>(
  async () => "replied",
);
vi.mock("@/lib/ai/auto-reply", () => ({
  dispatchInboundToAiReply: (...a: unknown[]) =>
    (aiReply as unknown as (...x: unknown[]) => unknown)(...a),
}));

import { dispatchInboundToFlows, entryTriggerTexts } from "./engine";
import type { ParsedInbound } from "./types";

const KEYWORD_FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["order status"] },
  entry_node_id: "start",
  created_at: "2026-01-01T00:00:00Z",
};

const NODES = [
  {
    id: "n1",
    flow_id: "flow-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "greet" },
  },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "greet",
    node_type: "send_message",
    config: { text: "Looking that up…", next_node_key: "done" },
  },
  {
    id: "n3",
    flow_id: "flow-1",
    node_key: "done",
    node_type: "end",
    config: {},
  },
];

function dispatch(message: ParsedInbound) {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message,
    isFirstInboundMessage: false,
  });
}

/** flow_runs INSERTs made during a dispatch. */
function startedRuns() {
  return h.state.inserted.filter((i) => i.table === "flow_runs");
}

beforeEach(() => {
  // No run in progress — the whole point is the entry-trigger path.
  h.state.activeRuns = [];
  h.state.flows = [];
  h.state.nodes = NODES;
  h.state.inserted = [];
  h.state.updates = [];
  h.state.insertedRun = null;
  h.state.rpcCalls = [];
  engineSendText.mockClear();
  engineSendInteractiveButtons.mockClear();
  aiReply.mockClear();
  aiReply.mockResolvedValue("replied");
});

describe("entryTriggerTexts", () => {
  it("offers the typed text for a text message", () => {
    expect(
      entryTriggerTexts({
        kind: "text",
        text: "order status",
        meta_message_id: "m1",
      }),
    ).toEqual(["order status"]);
  });

  it("offers both the button title and its reply id", () => {
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "Order status",
        meta_message_id: "m1",
      }),
    ).toEqual(["Order status", "btn_1"]);
  });

  it("drops blanks and collapses a title identical to the id", () => {
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "btn_1",
        meta_message_id: "m1",
      }),
    ).toEqual(["btn_1"]);
    expect(
      entryTriggerTexts({
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "   ",
        meta_message_id: "m1",
      }),
    ).toEqual(["btn_1"]);
  });
});

describe("dispatchInboundToFlows — entry triggers (#490)", () => {
  it("starts a keyword flow when the customer taps a matching button", async () => {
    h.state.flows = [KEYWORD_FLOW];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "btn_1",
      reply_title: "Order status",
      meta_message_id: "m1",
    });

    // Before the fix this returned {consumed: false, outcome: "no_match"}
    // — the tap was rejected before the keyword matcher ever ran.
    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(
      h.state.inserted.filter((i) => i.table === "flow_runs"),
    ).toHaveLength(1);
    expect(h.state.rpcCalls).toContain("increment_flow_execution_count");
    // The flow really ran, not just got created.
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });

  it("matches on the reply id when the visible title does not", async () => {
    h.state.flows = [
      { ...KEYWORD_FLOW, trigger_config: { keywords: ["order_status"] } },
    ];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "order_status",
      reply_title: "Where is my parcel?",
      meta_message_id: "m1",
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(startedRuns()).toHaveLength(1);
  });

  it("still starts the same flow for the typed text (unchanged path)", async () => {
    h.state.flows = [KEYWORD_FLOW];

    const result = await dispatch({
      kind: "text",
      text: "order status please",
      meta_message_id: "m1",
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(startedRuns()).toHaveLength(1);
  });

  it("leaves a non-matching tap for the automations dispatcher", async () => {
    h.state.flows = [KEYWORD_FLOW];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "btn_9",
      reply_title: "Talk to a human",
      meta_message_id: "m1",
    });

    // consumed:false is what lets the webhook fire the
    // `interactive_reply` automation trigger instead.
    expect(result.consumed).toBe(false);
    expect(result.outcome).toBe("no_match");
    expect(h.state.inserted.filter((i) => i.table === "flow_runs")).toEqual([]);
  });

  it("does not start a manual-trigger flow from a tap", async () => {
    h.state.flows = [{ ...KEYWORD_FLOW, trigger_type: "manual" }];

    const result = await dispatch({
      kind: "interactive_reply",
      reply_id: "btn_1",
      reply_title: "Order status",
      meta_message_id: "m1",
    });

    expect(result.consumed).toBe(false);
  });

  it("starts a first_inbound_message flow when the first inbound is a tap", async () => {
    h.state.flows = [
      {
        ...KEYWORD_FLOW,
        trigger_type: "first_inbound_message",
        trigger_config: {},
      },
    ];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: {
        kind: "interactive_reply",
        reply_id: "btn_1",
        reply_title: "Yes, tell me more",
        meta_message_id: "m1",
      },
      isFirstInboundMessage: true,
    });

    // A broadcast template's quick-reply button can genuinely be a
    // contact's first-ever inbound; the automations side already
    // treated it that way.
    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");
    expect(startedRuns()).toHaveLength(1);
  });
});

// ============================================================
// Campaign-started runs (migration 054).
// ============================================================

const MANUAL_FLOW = {
  ...KEYWORD_FLOW,
  id: "flow-campaign",
  trigger_type: "manual",
  trigger_config: {},
};

describe("dispatchInboundToFlows — campaign follow-up flow (054)", () => {
  it("starts the campaign's flow on the first reply, seeded with the reply", async () => {
    h.state.flows = [MANUAL_FLOW];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      campaign: { broadcastId: "bc-1", followUpFlowId: "flow-campaign" },
      message: {
        kind: "interactive_reply",
        reply_id: "pos",
        reply_title: "POS Machine",
        meta_message_id: "m1",
      },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    // The three-node fixture runs straight through to its end node.
    expect(result.outcome).toBe("completed");
    const [run] = startedRuns();
    expect(run.row).toMatchObject({
      flow_id: "flow-campaign",
      broadcast_id: "bc-1",
      vars: { campaign_reply: "POS Machine", campaign_reply_id: "pos" },
    });
    // A manual-trigger flow — which never starts from a tap on its own
    // (see the entry-trigger suite) — really ran.
    expect(engineSendText).toHaveBeenCalledTimes(1);
  });

  it("wins over a keyword flow the reply also matches", async () => {
    h.state.flows = [MANUAL_FLOW, KEYWORD_FLOW];

    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      campaign: { broadcastId: "bc-1", followUpFlowId: "flow-campaign" },
      message: { kind: "text", text: "order status", meta_message_id: "m1" },
      isFirstInboundMessage: false,
    });

    expect(startedRuns()[0].row.flow_id).toBe("flow-campaign");
  });

  it("falls through to the entry triggers when the campaign's flow is not active", async () => {
    h.state.flows = [{ ...MANUAL_FLOW, status: "archived" }, KEYWORD_FLOW];

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      campaign: { broadcastId: "bc-1", followUpFlowId: "flow-campaign" },
      message: { kind: "text", text: "order status", meta_message_id: "m1" },
      isFirstInboundMessage: false,
    });

    expect(result.consumed).toBe(true);
    expect(startedRuns()[0].row.flow_id).toBe("flow-1");
    expect(startedRuns()[0].row.broadcast_id).toBeUndefined();
  });
});

// ============================================================
// Off-script replies mid-run: the `ai` fallback and broken runs (054).
// ============================================================

const MENU_NODES = [
  {
    id: "n1",
    flow_id: "flow-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "menu" },
  },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "menu",
    node_type: "send_buttons",
    config: {
      text: "Quote or comparison?",
      buttons: [
        { reply_id: "quote", title: "Get a quote", next_node_key: "done" },
        { reply_id: "compare", title: "Compare", next_node_key: "done" },
      ],
    },
  },
  {
    id: "n3",
    flow_id: "flow-1",
    node_key: "done",
    node_type: "end",
    config: {},
  },
];

const ACTIVE_RUN = {
  id: "run-1",
  flow_id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  contact_id: "ct-1",
  conversation_id: "cv-1",
  status: "active",
  current_node_key: "menu",
  vars: {},
  reprompt_count: 0,
};

const AI_FLOW = {
  ...KEYWORD_FLOW,
  name: "POS onboarding",
  fallback_policy: {
    on_unknown_reply: "ai",
    max_reprompts: 1,
    on_exhaust: "handoff",
  },
};

function dispatchOffScript() {
  return dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    inboundProvider: "whapi",
    message: {
      kind: "text",
      text: "how much is the rental?",
      meta_message_id: "m2",
    },
    isFirstInboundMessage: false,
  });
}

/** flow_runs UPDATEs made during a dispatch. */
function runUpdates() {
  return h.state.updates
    .filter((u) => u.table === "flow_runs")
    .map((u) => u.row);
}

describe("dispatchInboundToFlows — `ai` fallback (054)", () => {
  beforeEach(() => {
    h.state.activeRuns = [ACTIVE_RUN];
    h.state.flows = [AI_FLOW];
    h.state.nodes = MENU_NODES;
  });

  it("hands an off-script question to the AI agent with the step's context, and keeps the run where it is", async () => {
    const result = await dispatchOffScript();

    expect(result).toMatchObject({ consumed: true, outcome: "fallback_fired" });
    expect(aiReply).toHaveBeenCalledTimes(1);
    expect(aiReply.mock.calls[0][0]).toMatchObject({
      accountId: "acct-1",
      conversationId: "cv-1",
      contactId: "ct-1",
      inboundProvider: "whapi",
      flowContext: {
        flowName: "POS onboarding",
        promptText: "Quote or comparison?",
        options: ["Get a quote", "Compare"],
      },
    });
    // No reprompt, no counter bump, no status change — the buttons stay live.
    expect(engineSendInteractiveButtons).not.toHaveBeenCalled();
    expect(runUpdates()).toEqual([]);
  });

  it("ends the run as handed off when the agent hands off", async () => {
    aiReply.mockResolvedValue("handed_off");

    const result = await dispatchOffScript();

    expect(result).toMatchObject({ consumed: true, outcome: "handed_off" });
    expect(runUpdates()).toContainEqual(
      expect.objectContaining({
        status: "handed_off",
        end_reason: "ai_handoff",
      }),
    );
    expect(
      h.state.updates
        .filter((u) => u.table === "conversations")
        .map((u) => u.row),
    ).toContainEqual(expect.objectContaining({ status: "pending" }));
  });

  it("re-sends the options when the agent declines (off / capped / human-owned)", async () => {
    aiReply.mockResolvedValue("skipped");

    const result = await dispatchOffScript();

    expect(result).toMatchObject({ consumed: true, outcome: "fallback_fired" });
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(runUpdates()).toContainEqual({ reprompt_count: 1 });
  });

  it("re-sends the options without asking when the inbound number is unknown", async () => {
    await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      message: { kind: "text", text: "how much?", meta_message_id: "m2" },
      isFirstInboundMessage: false,
    });
    expect(aiReply).not.toHaveBeenCalled();
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
  });

  it("does not involve the agent under the reprompt policy", async () => {
    h.state.flows = [KEYWORD_FLOW]; // default policy: reprompt
    await dispatchOffScript();
    expect(aiReply).not.toHaveBeenCalled();
    expect(engineSendInteractiveButtons).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchInboundToFlows — a broken run hands the message back (054)", () => {
  it("returns consumed:false / failed when the node the run waits on is gone", async () => {
    h.state.activeRuns = [{ ...ACTIVE_RUN, current_node_key: "deleted_node" }];
    h.state.flows = [AI_FLOW];
    h.state.nodes = MENU_NODES;

    const result = await dispatchOffScript();

    // Before 054 this was consumed:true / no_match — the customer's
    // message vanished into a run that had just died.
    expect(result).toEqual({
      consumed: false,
      flow_run_id: "run-1",
      outcome: "failed",
    });
    expect(runUpdates()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        end_reason: "current_node_not_found",
      }),
    );
    expect(aiReply).not.toHaveBeenCalled();
  });

  it("returns consumed:false / failed when a send fails mid-advance", async () => {
    h.state.activeRuns = [ACTIVE_RUN];
    h.state.flows = [AI_FLOW];
    h.state.nodes = [
      ...MENU_NODES.slice(0, 2),
      {
        id: "n3",
        flow_id: "flow-1",
        node_key: "done",
        node_type: "send_message",
        config: { text: "Thanks", next_node_key: "end" },
      },
      {
        id: "n4",
        flow_id: "flow-1",
        node_key: "end",
        node_type: "end",
        config: {},
      },
    ];
    engineSendText.mockRejectedValueOnce(new Error("gateway down"));

    const result = await dispatchInboundToFlows({
      accountId: "acct-1",
      userId: "u-1",
      contactId: "ct-1",
      conversationId: "cv-1",
      inboundProvider: "whapi",
      message: {
        kind: "interactive_reply",
        reply_id: "quote",
        reply_title: "Get a quote",
        meta_message_id: "m3",
      },
      isFirstInboundMessage: false,
    });

    expect(result).toMatchObject({ consumed: false, outcome: "failed" });
    expect(runUpdates()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        end_reason: "send_text_failed",
      }),
    );
  });
});
