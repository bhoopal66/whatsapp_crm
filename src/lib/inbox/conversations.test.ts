import { describe, it, expect } from "vitest";
import {
  UNASSIGNED,
  matchesAssignee,
  matchesContactFilters,
  normalizeConversation,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      })
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null })
    ).toBe(true);
    expect(matchesContactFilters(conv, { tagIds: ["t9"], company: null })).toBe(
      false
    );
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(matchesContactFilters(conv, { tagIds: ["t1"], company: null })).toBe(
      false
    );
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      })
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(matchesContactFilters(conv, { tagIds: [], company: "Acme" })).toBe(
      true
    );
    expect(matchesContactFilters(conv, { tagIds: [], company: "Other" })).toBe(
      false
    );
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" })
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" })
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" })
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

describe("matchesAssignee", () => {
  const held = (assignedTo: string | undefined): Conversation => ({
    ...makeConversation(null),
    // `user_id` stays "u1" throughout: on an inbound chat it is the
    // WhatsApp config owner, never the person handling the customer,
    // so it must not influence this filter.
    assigned_agent_id: assignedTo,
  });

  it("matches everything when no agent is selected", () => {
    expect(matchesAssignee(held("agent-a"), null)).toBe(true);
    expect(matchesAssignee(held(undefined), null)).toBe(true);
  });

  it("matches only the chats that agent holds", () => {
    expect(matchesAssignee(held("agent-a"), "agent-a")).toBe(true);
    expect(matchesAssignee(held("agent-b"), "agent-a")).toBe(false);
    expect(matchesAssignee(held(undefined), "agent-a")).toBe(false);
  });

  it("picks out the chats nobody has taken", () => {
    expect(matchesAssignee(held(undefined), UNASSIGNED)).toBe(true);
    expect(matchesAssignee(held("agent-a"), UNASSIGNED)).toBe(false);
  });

  it("falls back to the owner when nobody has been assigned", () => {
    // "u1" owns the row and nobody took it. Filtering by u1 surfaces
    // it: the Inbox names u1 as the handler of that chat, so the
    // by-agent filter has to agree with the name on screen.
    expect(matchesAssignee(held(undefined), "u1")).toBe(true);
  });

  it("lets the assignee win over the owner", () => {
    // Once a chat is handed to someone, its owner stops answering for
    // it — otherwise every inbound thread would stay under the name of
    // whoever connected the WhatsApp channel forever.
    expect(matchesAssignee(held("agent-a"), "u1")).toBe(false);
  });

  it("keeps an owned-but-unassigned chat in the triage queue", () => {
    // Deliberate overlap: the same row answers to its owner's name and
    // to Unassigned. Unassigned is "nobody has taken this", which an
    // inherited owner does not change.
    expect(matchesAssignee(held(undefined), "u1")).toBe(true);
    expect(matchesAssignee(held(undefined), UNASSIGNED)).toBe(true);
  });
});
