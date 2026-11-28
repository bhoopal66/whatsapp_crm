-- ============================================================
-- 321 — a failed reply restarts the customer's wait; time-based
-- automations get a run ledger.
--
-- 1. Failed replies (237 follow-up). 237's messages trigger ends a
--    customer's wait on any agent or bot message that is not failed
--    when it is INSERTED. A reply is usually inserted as 'sending' or
--    'sent' and only later turns 'failed' (the gateway refused it, a
--    Meta receipt said so), so the customer stayed "answered" although
--    nothing reached them: no worklist row, no Live view count, no
--    escalation bell. A second trigger, on the UPDATE that turns an
--    outbound message 'failed', works the wait out again from the chat's
--    own messages: the oldest customer message after the newest
--    outbound message that did not fail. Restoring that time continues
--    the same waiting episode, so a level that already rang (237's
--    ledger is keyed on waiting_since) does not ring twice. Like 237's,
--    it must never fail the status write: errors become WARNINGs.
--
-- 2. `automation_schedule_runs`: one row per (time-based automation,
--    scheduled minute), claimed before the run starts, so a slot runs at
--    most once however many cron passes or processes see it. Service
--    role only (RLS on, no policy, no client grants).
--
-- Guarded and re-runnable. Apply after 237 (and after 320 on an install
-- that has it).
-- ============================================================

-- ---- 1. failed replies -------------------------------------
CREATE OR REPLACE FUNCTION public.response_reopen_waiting_on_failure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last_reply timestamptz;
  v_since      timestamptz;
BEGIN
  IF NEW.conversation_id IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    -- Only a company chat that is open and not already waiting.
    PERFORM 1
       FROM public.conversations c
      WHERE c.id = NEW.conversation_id
        AND c.personal_owner_id IS NULL
        AND c.status <> 'closed'
        AND c.customer_waiting_since IS NULL;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    SELECT max(m.created_at) INTO v_last_reply
      FROM public.messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND m.sender_type <> 'customer'
       AND m.status IS DISTINCT FROM 'failed';

    SELECT min(m.created_at) INTO v_since
      FROM public.messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND m.sender_type = 'customer'
       AND (v_last_reply IS NULL OR m.created_at > v_last_reply);

    IF v_since IS NOT NULL THEN
      PERFORM set_config('app.response_waiting', 'on', true);
      UPDATE public.conversations c
         SET customer_waiting_since = v_since
       WHERE c.id = NEW.conversation_id
         AND c.customer_waiting_since IS NULL
         AND c.personal_owner_id IS NULL
         AND c.status <> 'closed';
      PERFORM set_config('app.response_waiting', '', true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'response_reopen_waiting_on_failure: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.response_reopen_waiting_on_failure()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_response_reopen_on_failure ON public.messages;
CREATE TRIGGER messages_response_reopen_on_failure
  AFTER UPDATE OF status ON public.messages
  FOR EACH ROW
  WHEN (NEW.status = 'failed'
        AND OLD.status IS DISTINCT FROM 'failed'
        AND NEW.sender_type <> 'customer')
  EXECUTE FUNCTION public.response_reopen_waiting_on_failure();

-- ---- 2. time-based automation runs -------------------------
CREATE TABLE IF NOT EXISTS public.automation_schedule_runs (
  automation_id uuid NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  slot          timestamptz NOT NULL,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  chats_matched integer,
  chats_run     integer,
  note          text,
  CONSTRAINT automation_schedule_runs_pkey PRIMARY KEY (automation_id, slot)
);

CREATE INDEX IF NOT EXISTS automation_schedule_runs_claimed_idx
  ON public.automation_schedule_runs (claimed_at);

ALTER TABLE public.automation_schedule_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_schedule_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_schedule_runs TO service_role;

COMMENT ON TABLE public.automation_schedule_runs IS
  'One row per time-based automation and scheduled minute, claimed before the run (at most once per slot). Service role only. Migration 321.';
