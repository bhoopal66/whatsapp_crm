import { describe, expect, it } from "vitest";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./validate";
import { TRIGGER_META } from "./trigger-meta";

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "set_chat_tag", step_config: { chat_tag_id: "tag-uuid" } },
      {
        step_type: "set_chat_tag",
        step_config: { chat_tag_id: "tag-uuid", chat_sub_tag_id: "sub-uuid" },
      },
      // null is "No tag": clears the chat's tags.
      { step_type: "set_chat_tag", step_config: { chat_tag_id: null } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "set_chat_tag", step_config: { chat_tag_id: "" } },
      { step_type: "set_chat_tag", step_config: {} },
      {
        step_type: "set_chat_tag",
        step_config: { chat_tag_id: null, chat_sub_tag_id: "sub-uuid" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].chat_tag_id",
      "steps[3].chat_tag_id",
      "steps[4].chat_sub_tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("checks a round_robin step's people and switch", () => {
    expect(
      validateStepsForActivation([
        {
          step_type: "assign_conversation",
          step_config: { mode: "round_robin", people: ["u1", "u2"], enabled: false },
        },
      ]),
    ).toEqual([]);
    const bad = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin", people: ["u1", ""], enabled: "yes" },
      },
    ]);
    expect(bad.map((i) => i.path)).toEqual([
      "steps[0].people",
      "steps[0].enabled",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("validates send_buttons / send_list interactive payloads", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [{ id: "yes", title: "Yes" }],
        },
      },
    ]);
    expect(good).toEqual([]);

    const tooMany = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [
            { id: "a", title: "A" },
            { id: "b", title: "B" },
            { id: "c", title: "C" },
            { id: "d", title: "D" },
          ],
        },
      },
    ]);
    expect(tooMany.map((i) => i.path)).toEqual(["steps[0].interactive"]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag", operand: "vip" },
        branches: {
          yes: [{ step_type: "set_chat_tag", step_config: { chat_tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].chat_tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("refuses the retired contact-tag condition subject", () => {
    expect(
      validateStepsForActivation([
        {
          step_type: "condition",
          step_config: { subject: "tag_presence", operand: "tag-uuid" },
        },
      ]),
    ).toEqual([
      {
        path: "steps[0].subject",
        message: "contact tags were retired; check the chat tag instead",
      },
    ]);
    expect(
      validateStepsForActivation([
        {
          step_type: "condition",
          step_config: { subject: "chat_tag_presence", operand: "tag-uuid" },
        },
      ]),
    ).toEqual([]);
  });

  it("flags condition subject/operand independently", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].operand",
      "steps[0].subject",
    ]);
  });
});

describe("validateStepsForActivation — post_team_chat", () => {
  it("accepts a channel and a message", () => {
    expect(
      validateStepsForActivation([
        {
          step_type: "post_team_chat",
          step_config: { channel_id: "ch-1", text: "New lead: {{ message.text }}" },
        },
      ]),
    ).toEqual([]);
  });

  it("needs a channel and non-blank text", () => {
    const issues = validateStepsForActivation([
      { step_type: "post_team_chat", step_config: {} },
      { step_type: "post_team_chat", step_config: { channel_id: " ", text: "  " } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].channel_id",
      "steps[0].text",
      "steps[1].channel_id",
      "steps[1].text",
    ]);
  });

  it("refuses text the chat could never store", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "post_team_chat",
        step_config: { channel_id: "ch-1", text: "é".repeat(8001) },
      },
    ]);
    expect(issues).toEqual([
      {
        path: "steps[0].text",
        message: "message text is longer than 8000 characters",
      },
    ]);
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("accepts keyword_match with a missing match_type (defaults to contains)", () => {
    expect(
      validateTriggerForActivation("keyword_match", { keywords: ["hi"] }),
    ).toEqual([]);
  });

  it("accepts the word match_type (issue #409)", () => {
    // Activation validation has to stay in step with the engine and the
    // builder's dropdown — an automation the UI can save must not be
    // rejected on activation.
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hi"],
        match_type: "word",
      }),
    ).toEqual([]);
  });

  it("refuses conversation_assigned, which nothing dispatches", () => {
    expect(
      validateTriggerForActivation("conversation_assigned", {}),
    ).toEqual([
      { path: "trigger.type", message: "this trigger does not run yet" },
    ]);
  });

  describe("time_based (migration 321's runner)", () => {
    const TAG = "11111111-2222-4333-8444-555555555555";

    it("accepts a readable schedule with a chat tag", () => {
      expect(
        validateTriggerForActivation("time_based", {
          schedule: "0 9 * * 1-5",
          chat_tag_id: TAG,
        }),
      ).toEqual([]);
      expect(
        validateTriggerForActivation("time_based", {
          schedule: "09:30",
          chat_tag_id: TAG,
          quiet_days: 3,
          timezone: "Asia/Dubai",
        }),
      ).toEqual([]);
    });

    it("requires a chat tag, so a run never reaches every chat", () => {
      expect(
        validateTriggerForActivation("time_based", { schedule: "0 9 * * *" }),
      ).toEqual([
        { path: "trigger.chat_tag_id", message: "no chat tag is chosen" },
      ]);
    });

    it("refuses a schedule, zone or quiet days it cannot run", () => {
      expect(
        validateTriggerForActivation("time_based", {
          schedule: "every morning",
          chat_tag_id: TAG,
        }),
      ).toEqual([
        { path: "trigger.schedule", message: "the schedule cannot be read" },
      ]);
      expect(
        validateTriggerForActivation("time_based", {
          schedule: "0 9 * * *",
          chat_tag_id: TAG,
          timezone: "Mars/Olympus",
        }),
      ).toEqual([
        { path: "trigger.timezone", message: "the time zone is unknown" },
      ]);
      expect(
        validateTriggerForActivation("time_based", {
          schedule: "0 9 * * *",
          chat_tag_id: TAG,
          quiet_days: 0,
        }),
      ).toEqual([
        {
          path: "trigger.quiet_days",
          message: "quiet days must be a whole number from 1 to 365",
        },
      ]);
    });
  });

  it("requires a main tag on chat_tag_set triggers; the sub-tag is optional", () => {
    expect(validateTriggerForActivation("chat_tag_set", {})).toEqual([
      { path: "trigger.chat_tag_id", message: "chat tag is required" },
    ]);
    expect(
      validateTriggerForActivation("chat_tag_set", { chat_tag_id: "tag-uuid" }),
    ).toEqual([]);
    expect(
      validateTriggerForActivation("chat_tag_set", {
        chat_tag_id: "tag-uuid",
        chat_sub_tag_id: "sub-uuid",
      }),
    ).toEqual([]);
  });

  it("refuses a chat_tag_set sub-tag with no main tag", () => {
    expect(
      validateTriggerForActivation("chat_tag_set", {
        chat_tag_id: "",
        chat_sub_tag_id: "sub-uuid",
      }),
    ).toEqual([
      { path: "trigger.chat_tag_id", message: "chat tag is required" },
      { path: "trigger.chat_sub_tag_id", message: "a sub-tag needs its main tag" },
    ]);
  });

  it("refuses a retired contact-tag step instead of activating it", () => {
    expect(
      validateStepsForActivation([
        { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      ]),
    ).toEqual([{ path: "steps[0]", message: "unknown step type: add_tag" }]);
  });

  it("requires reply_ids on interactive_reply triggers", () => {
    expect(validateTriggerForActivation("interactive_reply", {})).toEqual([
      { path: "trigger.reply_ids", message: "at least one reply id is required" },
    ]);
    expect(
      validateTriggerForActivation("interactive_reply", { reply_ids: ["yes", "no"] }),
    ).toEqual([]);
    const empties = validateTriggerForActivation("interactive_reply", {
      reply_ids: ["yes", "  "],
    });
    expect(empties.map((i) => i.message)).toContain(
      "reply ids cannot be empty strings",
    );
  });

  it("refuses a trigger type outside AutomationTriggerType", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([
      { path: "trigger.type", message: "unknown trigger type: some_future_trigger" },
    ]);
  });

  it("refuses the retired contact-tag trigger", () => {
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([{ path: "trigger.type", message: "unknown trigger type: tag_added" }]);
  });

  it("knows every trigger in TRIGGER_META", () => {
    for (const t of Object.keys(TRIGGER_META)) {
      const issues = validateTriggerForActivation(t, {});
      expect(issues.map((i) => i.message).join()).not.toContain("unknown trigger");
    }
  });
});

describe("contact_field condition", () => {
  const issuesFor = (operand: string) =>
    validateStepsForActivation([
      { step_type: "condition", step_config: { subject: "contact_field", operand, value: "x" } },
    ])

  it("refuses a field the condition cannot read", () => {
    expect(issuesFor("company_name")).toEqual([
      { path: "steps[0].operand", message: "unknown contact field: company_name" },
    ])
  })

  it.each(["name", "phone", "email", "company"])("accepts %s", (field) => {
    expect(issuesFor(field)).toEqual([])
  })
})
