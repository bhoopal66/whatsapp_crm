-- Regression check for migration 324: the time-based claim table exists,
-- holds one row per (automation, chat, occurrence) so a second claim of
-- the same occurrence writes nothing, and the client roles cannot touch
-- it. ONE statement on purpose (the pinned CLI rejects several); the
-- fixtures are rolled back by a sentinel.

DO $verify$
DECLARE
  n INT := 0;
  failed TEXT[] := '{}';
  v_account UUID := '00000000-0000-0000-0000-000000324a01';
  v_user UUID := '00000000-0000-0000-0000-000000324a02';
  v_contact UUID := '00000000-0000-0000-0000-000000324a03';
  v_conv UUID := '00000000-0000-0000-0000-000000324a04';
  v_auto UUID := '00000000-0000-0000-0000-000000324a05';
  v_occ TIMESTAMPTZ := '2026-11-28 05:00:00+00';
  v_rows INT;
BEGIN
  IF to_regclass('public.automation_time_runs') IS NULL THEN
    RAISE EXCEPTION 'verify-time-based-automations: automation_time_runs is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_time_runs'::regclass) THEN
    failed := failed || 'RLS is off'::text; END IF; n := n + 1;
  IF has_table_privilege('authenticated', 'public.automation_time_runs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.automation_time_runs', 'INSERT')
     OR has_table_privilege('anon', 'public.automation_time_runs', 'SELECT') THEN
    failed := failed || 'a client role has a grant'::text; END IF; n := n + 1;

  BEGIN
    INSERT INTO auth.users (id, email) VALUES (v_user, 'tba324-owner@example.invalid');
    INSERT INTO public.accounts (id, name, owner_user_id) VALUES (v_account, 'tba324', v_user);
    INSERT INTO public.contacts (id, account_id, user_id, phone, name)
      VALUES (v_contact, v_account, v_user, '+971500000324', 'tba324');
    INSERT INTO public.conversations (id, account_id, user_id, contact_id)
      VALUES (v_conv, v_account, v_user, v_contact);
    INSERT INTO public.automations (id, account_id, user_id, name, trigger_type, trigger_config)
      VALUES (v_auto, v_account, v_user, 'tba324', 'time_based',
              jsonb_build_object('schedule', '0 9 * * *', 'chat_tag_id', gen_random_uuid()));

    INSERT INTO public.automation_time_runs (automation_id, account_id, conversation_id, occurrence_at)
      VALUES (v_auto, v_account, v_conv, v_occ)
      ON CONFLICT (automation_id, conversation_id, occurrence_at) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN failed := failed || 'the first claim wrote nothing'::text; END IF; n := n + 1;

    INSERT INTO public.automation_time_runs (automation_id, account_id, conversation_id, occurrence_at)
      VALUES (v_auto, v_account, v_conv, v_occ)
      ON CONFLICT (automation_id, conversation_id, occurrence_at) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN failed := failed || 'a second claim of the occurrence was written'::text; END IF; n := n + 1;

    INSERT INTO public.automation_time_runs (automation_id, account_id, conversation_id, occurrence_at)
      VALUES (v_auto, v_account, v_conv, v_occ + interval '1 day')
      ON CONFLICT (automation_id, conversation_id, occurrence_at) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN failed := failed || 'the next occurrence could not be claimed'::text; END IF; n := n + 1;

    DELETE FROM public.conversations WHERE id = v_conv;
    IF EXISTS (SELECT 1 FROM public.automation_time_runs WHERE automation_id = v_auto) THEN
      failed := failed || 'claims outlived their chat'::text; END IF; n := n + 1;

    RAISE EXCEPTION 'TBA324_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'TBA324_ROLLBACK' THEN RAISE; END IF;
  END;

  IF n <> 6 THEN RAISE EXCEPTION 'verify-time-based-automations: only % checks ran', n; END IF;
  IF cardinality(failed) > 0 THEN
    RAISE EXCEPTION 'verify-time-based-automations: % failed: %', cardinality(failed), array_to_string(failed, '; ');
  END IF;
  RAISE NOTICE 'verify-time-based-automations: % checks passed', n;
END $verify$;
