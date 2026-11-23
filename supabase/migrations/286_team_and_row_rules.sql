-- ============================================================
-- 286_team_and_row_rules.sql — a row belongs to the same account as the
-- row it hangs from, and a person writes only their own.
--
--   1. Teams: a member row belongs to its team's account (composite FK,
--      policy, and every function that reads the roster).
--   2. The same for the other tables a session writes.
--   3. An unlock is given back only while nothing was sent with it.
--   4. A session writes only its own reaction, on the message's chat.
--   5. A customer note is edited by its author, deleted by its author or
--      an admin.
--   6. A deal is linked only to a customer, chat, pipeline and stage the
--      caller can see.
--
-- Functions are PATCHED from their live body (pg_get_functiondef) rather
-- than restated: the change is one join condition in some twenty bodies,
-- and a copy would undo whatever a neighbouring migration did to them. A
-- migration that restates one later must keep the condition:
-- verify-team-and-row-rules.sql reads every body and names the one that
-- lost it.
--
-- Nothing is refused and nothing deleted: rows that break the new rule
-- are counted in a NOTICE, ignored by the functions, and leave their
-- foreign key NOT VALID (still enforced for every new row). Re-running
-- the file after they are cleared validates it.
--
-- Re-runnable.
-- ============================================================

SET lock_timeout = '10s';

-- ---------- scan (before any DDL) ----------

DO $scan$
DECLARE n bigint; r bigint;
BEGIN
  SELECT count(*) INTO n
    FROM public.team_members tm JOIN public.teams t ON t.id = tm.team_id
   WHERE t.account_id <> tm.account_id;
  IF n > 0 THEN
    RAISE NOTICE '286: % team_members row(s) name a team of another account. They are kept, and ignored.', n;
  END IF;
  SELECT count(*) INTO r
    FROM public.whatsapp_routes wr JOIN public.whatsapp_config w ON w.id = wr.config_id
   WHERE w.account_id <> wr.account_id;
  IF r > 0 THEN
    RAISE NOTICE '286: % whatsapp_routes row(s) name a number of another account. They are kept: pick the number again in Settings.', r;
  END IF;
END
$scan$;

-- A roster reader whose body is not what 286 patches refuses here, before
-- any change: it would keep the join without the account.
DO $shape$
DECLARE
  f   record;
  def text;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'leads_teammate', 'led_teammate_user_ids', 'pbx_visible_user_ids',
         'contact_visibility_people', 'can_view_conversation_for_user',
         'conversation_note_user_can_see', 'memory_can_read',
         'whatsapp_group_visible_ids', 'team_activity_my_team',
         'team_activity_request_unlock', 'team_activity_decide_unlock',
         'team_activity_alert_sweep', 'team_activity_team_number_counts',
         'pbx_call_report', 'live_team_view', 'response_escalation_sweep',
         'chat_dm_pair_allowed', 'chat_user_in_channel_audience',
         'channel_team_desired_members', 'set_team_members')
  LOOP
    def := pg_get_functiondef(f.oid);
    IF def ~ '\mteam_members\M'
       AND def !~ '\m(tm|m)\.team_id = (t|ct)\.(id|team_id)\M'
       AND def !~ '\mt\.id = tm\.team_id AND t\.account_id = s\.account_id\M'
       AND def !~ '\mmb\.team_id = ma\.team_id\M'
       AND def !~ '(tm|m|mb)\.account_id = '
       AND f.proname <> 'set_team_members' THEN
      RAISE EXCEPTION '286: % reads team_members in a way this file does not know; look at it first', f.proname;
    END IF;
  END LOOP;
END
$shape$;

-- ---------- 1. teams ----------

-- One foreign key, not two: PostgREST refuses `teams(team_members(...))`
-- as ambiguous when both exist, and four screens embed it. The composite
-- key replaces the old one.
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.team_members'::regclass
                    AND conname = 'team_members_team_account_fkey') THEN
    ALTER TABLE public.team_members
      ADD CONSTRAINT team_members_team_account_fkey
      FOREIGN KEY (team_id, account_id)
      REFERENCES public.teams (id, account_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_members tm
                  WHERE NOT EXISTS (SELECT 1 FROM public.teams t
                                     WHERE t.id = tm.team_id AND t.account_id = tm.account_id)) THEN
    ALTER TABLE public.team_members VALIDATE CONSTRAINT team_members_team_account_fkey;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.whatsapp_routes'::regclass
                    AND conname = 'whatsapp_routes_config_account_fkey') THEN
    ALTER TABLE public.whatsapp_routes
      ADD CONSTRAINT whatsapp_routes_config_account_fkey
      FOREIGN KEY (config_id, account_id)
      REFERENCES public.whatsapp_config (id, account_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.whatsapp_routes wr
                  WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_config w
                                     WHERE w.id = wr.config_id AND w.account_id = wr.account_id)) THEN
    ALTER TABLE public.whatsapp_routes VALIDATE CONSTRAINT whatsapp_routes_config_account_fkey;
  END IF;
  -- In the same statement: with both keys an embed would be ambiguous.
  ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_team_id_fkey;
  ALTER TABLE public.whatsapp_routes DROP CONSTRAINT IF EXISTS whatsapp_routes_config_id_fkey;
END
$fk$;

-- The person is live staff of the same account, as 135 already asks of
-- set_team_members and whatsapp_channel_members_modify of a number.
DO $swap$ BEGIN
DROP POLICY IF EXISTS team_members_modify ON public.team_members;
CREATE POLICY team_members_modify ON public.team_members
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (
    is_account_member(account_id, 'admin')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = team_members.user_id
         AND p.account_id = team_members.account_id
         AND p.account_role <> 'bank_guest'
         AND p.deactivated_at IS NULL)
  );
END $swap$;

DO $patch$
DECLARE
  f   record;
  def text;
  new text;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'leads_teammate', 'led_teammate_user_ids', 'pbx_visible_user_ids',
         'contact_visibility_people', 'can_view_conversation_for_user',
         'conversation_note_user_can_see', 'memory_can_read',
         'whatsapp_group_visible_ids', 'team_activity_my_team',
         'team_activity_request_unlock', 'team_activity_decide_unlock',
         'team_activity_alert_sweep', 'team_activity_team_number_counts',
         'pbx_call_report', 'live_team_view', 'response_escalation_sweep',
         'chat_dm_pair_allowed', 'chat_user_in_channel_audience',
         'channel_team_desired_members', 'set_team_members')
  LOOP
    def := pg_get_functiondef(f.oid);
    -- a roster row joined to its team (or to the team's number)
    new := regexp_replace(def,
      '\m(tm|m)\.team_id = (t|ct)\.(id|team_id)\M(?! AND \w+\.account_id)',
      '\1.team_id = \2.\3 AND \1.account_id = \2.account_id', 'g');
    -- the sweep, written the other way round
    new := regexp_replace(new,
      '\mt\.id = tm\.team_id AND t\.account_id = s\.account_id\M(?! AND tm\.account_id)',
      't.id = tm.team_id AND t.account_id = s.account_id AND tm.account_id = t.account_id', 'g');
    -- two colleagues of one team
    new := regexp_replace(new,
      '\mmb\.team_id = ma\.team_id\M(?! AND mb\.account_id)',
      'mb.team_id = ma.team_id AND mb.account_id = ma.account_id', 'g');
    -- set_team_members: a current member may stay (135) although no longer
    -- live staff. The policy asks every proposed row, conflict or not, so
    -- only the new ones are proposed.
    IF f.proname = 'set_team_members' THEN
      new := regexp_replace(new,
        '(unnest\(v_ids\) AS x\(id\)\) u)(\s+)(ON CONFLICT)',
        E'\\1\\2WHERE NOT EXISTS (SELECT 1 FROM team_members cur\\2                   WHERE cur.team_id = p_team_id AND cur.account_id = v_account AND cur.user_id = u.id)\\2\\3');
    END IF;
    IF new <> def THEN
      EXECUTE new;
    END IF;
  END LOOP;
END
$patch$;

-- ---------- 2. the same rule on the other tables a session writes ----------
--
-- RESTRICTIVE, so each is added to whatever the table's own policies say
-- and none of those is restated. The service role and definer functions
-- pass RLS as before. Already closed by a composite key of their own:
-- whatsapp_channel_members, whatsapp_channel_teams,
-- calendar_event_attendees, meeting_invitees, broadcast_drafts, chat_tags;
-- by a guard: tasks, pipeline_stages, conversation_notes, saved_views.
DO $same$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('contact_tags', 'contact_tags_same_account',
       'EXISTS (SELECT 1 FROM public.tags x WHERE x.id = contact_tags.tag_id AND x.account_id = (SELECT current_account_id()))'),
      ('contact_custom_values', 'contact_custom_values_same_account',
       'EXISTS (SELECT 1 FROM public.custom_fields x WHERE x.id = contact_custom_values.custom_field_id AND x.account_id = (SELECT current_account_id()))'),
      ('broadcast_recipients', 'broadcast_recipients_same_account',
       'contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts x WHERE x.id = broadcast_recipients.contact_id AND x.account_id = (SELECT current_account_id()))'),
      ('broadcasts', 'broadcasts_same_account',
       'follow_up_flow_id IS NULL OR EXISTS (SELECT 1 FROM public.flows x WHERE x.id = broadcasts.follow_up_flow_id AND x.account_id = broadcasts.account_id)'),
      ('ai_knowledge_chunks', 'ai_knowledge_chunks_same_account',
       'EXISTS (SELECT 1 FROM public.ai_knowledge_documents x WHERE x.id = ai_knowledge_chunks.document_id AND x.account_id = ai_knowledge_chunks.account_id)')
    ) AS v(tbl, pol, chk)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.pol || '_insert', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK (%s)',
                   r.pol || '_insert', r.tbl, r.chk);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.pol || '_update', r.tbl);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (%s)',
                   r.pol || '_update', r.tbl, r.chk);
  END LOOP;
END
$same$;

-- ---------- 3. giving an unlock back ----------

-- The send route gives an unlock back only when its send certainly
-- failed, and then no message of theirs exists in that chat. A row the
-- gateway reported failed afterwards is still a send that was made.
CREATE OR REPLACE FUNCTION public.team_activity_release_unlock(p_conversation uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_account uuid := public.current_account_id();
  v_id      uuid;
BEGIN
  IF v_uid IS NULL OR v_account IS NULL OR p_conversation IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.team_activity_unlocks
     SET status = 'approved', used_at = NULL
   WHERE id = (
     SELECT u.id FROM public.team_activity_unlocks u
     WHERE u.requester_id = v_uid
       AND u.conversation_id = p_conversation
       AND u.account_id = v_account
       AND u.status = 'used'
       AND u.used_at > now() - interval '10 minutes'
       AND u.expires_at > now()
       -- 286: nothing of theirs went into the chat since it was spent
       AND NOT EXISTS (
         SELECT 1 FROM public.messages m
          WHERE m.conversation_id = u.conversation_id
            AND m.sender_type = 'agent'
            AND m.sender_id = v_uid
            AND m.created_at >= u.used_at)
     ORDER BY u.used_at DESC
     LIMIT 1
     FOR UPDATE SKIP LOCKED)
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END
$$;

REVOKE ALL ON FUNCTION public.team_activity_release_unlock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_activity_release_unlock(uuid) TO authenticated, service_role;

-- ---------- 4. reactions ----------

-- The customer's reaction, and a colleague's that the customer no longer
-- sees, are written by the server (inbound-pipeline.ts, react/route.ts)
-- with the service role.
DO $swap$ BEGIN
DROP POLICY IF EXISTS message_reactions_modify ON public.message_reactions;
CREATE POLICY message_reactions_modify ON public.message_reactions
  FOR ALL
  USING (
    actor_type = 'agent' AND actor_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = message_reactions.message_id
         AND is_account_member(c.account_id, 'agent')
         AND ((SELECT current_role_rank()) >= 4
              OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)))
  )
  WITH CHECK (
    actor_type = 'agent' AND actor_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = message_reactions.message_id
         AND m.conversation_id = message_reactions.conversation_id
         AND is_account_member(c.account_id, 'agent')
         AND ((SELECT current_role_rank()) >= 4
              OR can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id, c.channel_id, c.send_channel_id)))
  );
END $swap$;

-- ---------- 5. customer notes ----------

-- Added to 059's update and delete rules (the customer must be visible).
DO $swap$ BEGIN
DROP POLICY IF EXISTS contact_notes_update_own ON public.contact_notes;
CREATE POLICY contact_notes_update_own ON public.contact_notes
  AS RESTRICTIVE FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
END $swap$;

DO $swap$ BEGIN
DROP POLICY IF EXISTS contact_notes_delete_own ON public.contact_notes;
CREATE POLICY contact_notes_delete_own ON public.contact_notes
  AS RESTRICTIVE FOR DELETE
  USING (user_id = (SELECT auth.uid()) OR (SELECT current_role_rank()) >= 4);
END $swap$;

-- SECURITY INVOKER on purpose, here and below: current_user is the
-- session's role only when the session itself writes. A definer function,
-- a trigger of one and the service role pass.
CREATE OR REPLACE FUNCTION public.contact_notes_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.user_id, NEW.contact_id, NEW.account_id)
         IS DISTINCT FROM (OLD.user_id, OLD.contact_id, OLD.account_id) THEN
    RAISE EXCEPTION 'A note keeps its author and its customer'
      USING ERRCODE = '42501', HINT = 'note_frozen';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.contact_notes_frozen() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER contact_notes_frozen
  BEFORE UPDATE ON public.contact_notes
  FOR EACH ROW EXECUTE FUNCTION public.contact_notes_frozen();

-- ---------- 6. deals ----------

-- As can_link_task for tasks, but asked of RLS itself: a link that is set
-- or changed must name a row the caller can read. An unchanged link is
-- not asked again, so a deal handed on stays editable.
CREATE OR REPLACE FUNCTION public.deals_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     AND NOT EXISTS (SELECT 1 FROM contacts x
                      WHERE x.id = NEW.contact_id AND x.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The customer of a deal must be one you can see'
      USING ERRCODE = '42501', HINT = 'deal_link';
  END IF;
  IF NEW.conversation_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND NOT EXISTS (SELECT 1 FROM conversations x
                      WHERE x.id = NEW.conversation_id AND x.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The chat of a deal must be one you can see'
      USING ERRCODE = '42501', HINT = 'deal_link';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
      OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND NOT EXISTS (SELECT 1 FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
                      WHERE s.id = NEW.stage_id AND p.id = NEW.pipeline_id
                        AND p.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'The stage of a deal must belong to its pipeline'
      USING ERRCODE = '42501', HINT = 'deal_link';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.deals_link_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER deals_link_guard
  BEFORE INSERT OR UPDATE OF contact_id, conversation_id, pipeline_id, stage_id, account_id
  ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_link_guard();

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
