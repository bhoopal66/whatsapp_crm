-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The cost ledger (051) is written only through this function; if
  -- the CREATE FUNCTION were silently skipped the webhook would log a
  -- "function does not exist" on every delivery receipt and cost
  -- nothing, with inbound otherwise looking healthy.
  IF to_regprocedure('public.record_whatsapp_message_cost(uuid, text, jsonb, text)') IS NULL THEN
    RAISE EXCEPTION 'record_whatsapp_message_cost is missing — migration 051 did not apply';
  END IF;
  IF to_regclass('public.whatsapp_cost_monthly') IS NULL THEN
    RAISE EXCEPTION 'the whatsapp_cost_monthly view is missing (migration 051)';
  END IF;

  -- Both inbound pipelines and the send core write this column on
  -- every message insert, so a skipped 055 fails every message.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name = 'is_forwarded'
  ) THEN
    RAISE EXCEPTION 'messages.is_forwarded is missing — migration 055 did not apply';
  END IF;

  -- The Compass routes upsert ON CONFLICT (account_id, compass_id) and
  -- claim notifications against (account_id, idempotency_key); without
  -- those constraints every sync call and every send fails.
  IF to_regclass('public.compass_contacts') IS NULL
     OR to_regclass('public.compass_notifications') IS NULL THEN
    RAISE EXCEPTION 'compass_contacts / compass_notifications are missing — migration 056 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compass_contacts_account_compass_id_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'compass_notifications_account_key_key'
  ) THEN
    RAISE EXCEPTION 'compass unique constraints are missing (migration 056)';
  END IF;

  -- 057: holes that were each reopened by a later migration once
  -- already (047 recreated the knowledge search SECURITY DEFINER,
  -- undoing 032), so they are asserted, not assumed.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('match_ai_knowledge_fts', 'match_ai_knowledge_semantic')
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'match_ai_knowledge_* must be SECURITY INVOKER — it filters only on a caller-supplied account id (migrations 032/057)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'profiles must have no client INSERT policy — a user could insert themselves into any account (migration 057)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = 'SELECT' AND 'public' = ANY (roles)
  ) THEN
    RAISE EXCEPTION 'a storage SELECT policy applies to anon — it lets anyone list every tenant''s files (migration 057)';
  END IF;
  IF has_function_privilege('anon', 'public._bcast_bump(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_ai_reply_slot(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_webhook_failure(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service-only SECURITY DEFINER helpers are callable by clients (migration 057)';
  END IF;

  -- 059: the hot policies must carry the index-usable account predicate.
  IF to_regprocedure('public.current_account_id()') IS NULL THEN
    RAISE EXCEPTION 'current_account_id() is missing — migration 059 did not apply';
  END IF;

  -- 060: several Whapi numbers per account, with allocations. The
  -- 4-argument predicate is what every conversation policy now calls.
  IF to_regclass('public.whatsapp_channel_members') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_channel_members is missing — migration 060 did not apply';
  END IF;
  IF to_regprocedure('public.can_view_conversation(uuid, uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'can_view_conversation/4 is missing — migration 060 did not apply';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_account_provider_key'
  ) THEN
    RAISE EXCEPTION 'whatsapp_config still allows only one channel per provider — migration 060 did not apply';
  END IF;

  -- 061: per-chat sending number, and the thread notes behind it.
  IF to_regclass('public.conversation_events') IS NULL THEN
    RAISE EXCEPTION 'public.conversation_events is missing — migration 061 did not apply';
  END IF;
  IF to_regprocedure('public.set_conversation_send_channel(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'set_conversation_send_channel is missing — migration 061 did not apply';
  END IF;

  -- 062: numbers and pins are tied to their own account.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_account_fkey'
  ) THEN
    RAISE EXCEPTION 'conversations.channel_id is not tied to its account — migration 062 did not apply';
  END IF;
  IF to_regprocedure('public.set_channel_members(uuid, uuid[])') IS NULL THEN
    RAISE EXCEPTION 'set_channel_members is missing — migration 062 did not apply';
  END IF;

  -- 065: channel health alerts.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check'
      AND pg_get_constraintdef(oid) LIKE '%channel_disconnected%'
      AND pg_get_constraintdef(oid) LIKE '%conversation_assigned%'
  ) THEN
    RAISE EXCEPTION 'notifications_type_check lacks the channel alert types — migration 065 did not apply';
  END IF;

  -- 066: broadcast recipient reconcile (service role only).
  IF to_regprocedure('public.reconcile_broadcast_recipient_statuses(uuid, interval)') IS NULL
     OR to_regprocedure('public.describe_meta_failure(text, text, text)') IS NULL
     OR to_regclass('public.idx_whatsapp_message_costs_message') IS NULL THEN
    RAISE EXCEPTION 'reconcile_broadcast_recipient_statuses / describe_meta_failure / idx_whatsapp_message_costs_message missing — migration 066 did not apply';
  END IF;
  IF has_function_privilege('authenticated', 'public.reconcile_broadcast_recipient_statuses(uuid, interval)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reconcile_broadcast_recipient_statuses(uuid, interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reconcile_broadcast_recipient_statuses must be executable by service_role only (migration 066)';
  END IF;

  -- 067: campaign chats split between the Campaign inbox and the
  -- Inbox. The triggers record a person stepping in; without them a
  -- taken-over chat stays with the bot's and nothing errors. The lists
  -- call ai_auto_reply_live() before they load.
  IF to_regprocedure('public.ai_auto_reply_live()') IS NULL THEN
    RAISE EXCEPTION 'ai_auto_reply_live() is missing — migration 067 did not apply';
  END IF;
  IF has_function_privilege('anon', 'public.ai_auto_reply_live()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ai_auto_reply_live() must not be callable by anon (migration 067)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'human_engaged_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.conversations'::regclass
      AND tgname = 'conversations_human_engaged'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.messages'::regclass
      AND tgname = 'messages_human_engaged'
  ) THEN
    RAISE EXCEPTION 'conversations.human_engaged_at or its triggers are missing — migration 067 did not apply';
  END IF;

  -- 068: team activity.
  IF to_regclass('public.team_activity_settings') IS NULL
     OR to_regclass('public.team_activity_alerts') IS NULL
     OR to_regprocedure('public.team_activity_starts(uuid, timestamptz, timestamptz)') IS NULL
     OR to_regprocedure('public.team_activity_report(timestamptz, timestamptz, text, uuid)') IS NULL
     OR to_regprocedure('public.team_activity_chats(timestamptz, timestamptz, text, uuid, uuid, text, integer)') IS NULL
     OR to_regprocedure('public.team_activity_my_day(text)') IS NULL
     OR to_regprocedure('public.team_activity_start_check(uuid, uuid)') IS NULL
     OR to_regprocedure('public.team_activity_alert_sweep()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'notifications_type_check'
         AND pg_get_constraintdef(oid) LIKE '%team_activity_alert%'
         AND pg_get_constraintdef(oid) LIKE '%channel_disconnected%'
     ) THEN
    RAISE EXCEPTION 'team activity tables, functions or the team_activity_alert type are missing — migration 068 did not apply';
  END IF;

  -- 070: the avatar route selects this column for every contact the
  -- inbox loads, so without it no profile picture is ever fetched.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name = 'avatar_checked_at'
  ) THEN
    RAISE EXCEPTION 'contacts.avatar_checked_at is missing — migration 070 did not apply';
  END IF;

  -- 071: numbers allocated to a team, derived into the member list.
  IF to_regclass('public.whatsapp_channel_teams') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_channel_teams is missing — migration 071 did not apply';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_channel_members'
      AND column_name IN ('direct', 'via_team')
  ) <> 2 THEN
    RAISE EXCEPTION 'whatsapp_channel_members.direct / via_team are missing — migration 071 did not apply';
  END IF;
  IF to_regprocedure('public.sync_channel_team_members(uuid)') IS NULL
     OR to_regprocedure('public.set_channel_teams(uuid, uuid[])') IS NULL
     OR to_regprocedure('public.set_team_channels(uuid, uuid[])') IS NULL
     OR to_regprocedure('public.set_team_members(uuid, uuid[])') IS NULL
     OR to_regprocedure('public.update_team(uuid, text, boolean, uuid, uuid[], uuid[])') IS NULL
     OR to_regprocedure('public.set_channel_access(uuid, uuid[], uuid[])') IS NULL
     OR to_regprocedure('public.channel_access_lock_key(uuid)') IS NULL
     OR to_regprocedure('public.profiles_leave_account_teams()') IS NULL THEN
    RAISE EXCEPTION 'the team allocation functions are missing — migration 071 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'profiles_leave_account_teams'
      AND tgrelid = 'public.profiles'::regclass
  ) THEN
    RAISE EXCEPTION 'profiles_leave_account_teams trigger is missing — migration 071 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'team_members_sync_channels'
      AND tgrelid = 'public.team_members'::regclass
  ) THEN
    RAISE EXCEPTION 'team_members_sync_channels trigger is missing — migration 071 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
