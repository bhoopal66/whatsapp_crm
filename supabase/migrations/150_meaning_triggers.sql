-- ============================================================
-- 150_meaning_triggers.sql — flows may start on what the customer means
--
-- Until now a flow started on a keyword, on a contact's first inbound
-- message, or by hand. With Jev (see 147) judging what an inbound
-- message means, a flow can also start on an intent ("wants a loan",
-- "asks about a card") rather than an exact word. The intent itself and
-- its threshold live in flows.trigger_config, validated by the app like
-- every other trigger's config; the database only has to accept the
-- new trigger type.
--
--  * flows.trigger_type: 010 created the CHECK inline, unnamed, so
--    Postgres named it flows_trigger_type_check; no later migration
--    changed it. It is swapped for a named constraint that also allows
--    'intent'. The swap finds every CHECK on flows that mentions
--    trigger_type in the catalog rather than trusting the generated
--    name, and does nothing once 'intent' is already allowed.
--
--  * automations.trigger_type has no CHECK (006 left it to the
--    TypeScript validator), so the matching automation trigger
--    ('intent_match') needs no schema change here.
--
-- Re-runnable: the swap is one guarded DO block.
-- ============================================================

DO $$
DECLARE
  c record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.flows'::regclass
      AND contype = 'c'
      AND conname = 'flows_trigger_type_check'
      AND pg_get_constraintdef(oid) LIKE '%''intent''%'
  ) THEN
    RETURN;
  END IF;

  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.flows'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%trigger_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.flows DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE public.flows
    ADD CONSTRAINT flows_trigger_type_check
    CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'intent'));
END
$$;

COMMENT ON COLUMN public.flows.trigger_type IS
  'What starts the flow: keyword, first_inbound_message, manual, or intent (Jev''s judgment of what the customer means; intent and threshold in trigger_config, migration 150).';
