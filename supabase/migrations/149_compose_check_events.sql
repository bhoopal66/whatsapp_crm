-- ============================================================
-- 149_compose_check_events.sql — a log of pre-send message warnings
--
-- Before an agent's message goes out, Jev (see 147) may warn that it
-- looks like a promise, quotes terms, names a non-partner bank, claims
-- a regulator's backing, carries a secret, strikes the wrong tone or is
-- a cold pitch. This table records that a warning was shown and what
-- the agent did next, so admins can see which warnings fire and whether
-- they change behaviour.
--
--  * Codes only, never message text: warnings is a text[] of known
--    codes (1..10 of them), held to the list by a CHECK, so the log can
--    never become a second copy of what agents wrote.
--
--  * outcome moves from 'pending' to 'sent_anyway' or 'edited';
--    decided_at records when.
--
--  * conversation_id is a composite FK to conversations (id,
--    account_id) — 086's conversations_id_account_key — so a row can
--    only name a chat of its own account, with ON DELETE SET NULL
--    (conversation_id): the column list keeps account_id, and deleting
--    the chat keeps the log row.
--
--  * Who: admins of the account read (is_account_member(account_id,
--    'admin')); nobody writes from the browser. The API records and
--    settles rows with the service role, so there is no client INSERT,
--    UPDATE or DELETE policy and authenticated holds SELECT only.
--
-- Re-runnable: CREATE TABLE / INDEX IF NOT EXISTS, DROP POLICY IF
-- EXISTS before the policy, idempotent grants.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.compose_check_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid        NULL,
  warnings        text[]      NOT NULL
    CONSTRAINT compose_check_events_warnings_check
    CHECK (cardinality(warnings) BETWEEN 1 AND 10
           AND warnings <@ ARRAY['promise', 'terms', 'non_partner_bank',
                                 'regulator_claim', 'secrets', 'tone',
                                 'cold_pitch']::text[]),
  outcome         text        NOT NULL DEFAULT 'pending'
    CONSTRAINT compose_check_events_outcome_check
    CHECK (outcome IN ('pending', 'sent_anyway', 'edited')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz NULL,
  CONSTRAINT compose_check_events_conversation_fkey
    FOREIGN KEY (conversation_id, account_id)
    REFERENCES public.conversations (id, account_id)
    ON DELETE SET NULL (conversation_id)
);

CREATE INDEX IF NOT EXISTS compose_check_events_account_created_idx
  ON public.compose_check_events (account_id, created_at DESC);

COMMENT ON TABLE public.compose_check_events IS
  'Pre-send message warnings shown to an agent and what they did next. Codes only, never message text. Admins read; the service role writes (migration 149).';
COMMENT ON COLUMN public.compose_check_events.user_id IS
  'The auth user who was composing the message.';
COMMENT ON COLUMN public.compose_check_events.conversation_id IS
  'The chat the message was for; same-account composite FK, NULL once the chat is deleted.';
COMMENT ON COLUMN public.compose_check_events.warnings IS
  'Warning codes shown (1..10): promise, terms, non_partner_bank, regulator_claim, secrets, tone, cold_pitch.';
COMMENT ON COLUMN public.compose_check_events.outcome IS
  'pending until the agent acts: sent_anyway (sent unchanged) or edited.';
COMMENT ON COLUMN public.compose_check_events.decided_at IS
  'When outcome left pending.';

ALTER TABLE public.compose_check_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compose_check_events_select ON public.compose_check_events;
CREATE POLICY compose_check_events_select ON public.compose_check_events
  FOR SELECT TO authenticated
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON public.compose_check_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.compose_check_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compose_check_events TO service_role;
