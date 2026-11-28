-- 324: time-based automations run.
--
-- A `time_based` automation (trigger_config: schedule, timezone, and the
-- audience chat_tag_id / chat_sub_tag_id) is evaluated by the automations
-- cron (`lib/automations/time-based-run.ts`): each due occurrence of the
-- schedule starts the automation once for every chat at the tag.
--
-- automation_time_runs is the "once": the cron inserts (automation, chat,
-- occurrence) with ON CONFLICT DO NOTHING and starts only the chats whose
-- row it wrote, so a repeated or overlapping pass starts nobody twice.
-- Ids and times only; a row goes with its automation or its chat.
--
-- Written by the service role only: RLS on, no policy, no grant to the
-- client roles. Re-runnable.

CREATE TABLE IF NOT EXISTS public.automation_time_runs (
  automation_id   UUID NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  occurrence_at   TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (automation_id, conversation_id, occurrence_at)
);

COMMENT ON TABLE public.automation_time_runs IS
  'One row per (time-based automation, chat, schedule occurrence) the '
  'automations cron started (migration 324); the primary key is the '
  'at-most-once claim.';

-- The cron reads one occurrence of one automation: the primary key
-- leads with automation_id, so (automation_id, occurrence_at) is served
-- by its own index.
CREATE INDEX IF NOT EXISTS automation_time_runs_occurrence_idx
  ON public.automation_time_runs (automation_id, occurrence_at);

-- Old claims are only history: an occurrence is due for an hour at most.
CREATE INDEX IF NOT EXISTS automation_time_runs_created_idx
  ON public.automation_time_runs (created_at);

ALTER TABLE public.automation_time_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.automation_time_runs FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.automation_time_runs TO service_role;
