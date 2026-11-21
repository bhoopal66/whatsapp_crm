-- Behavioural regression suite for the SMS channel of HR automated
-- messages (migration 226).
--
-- 'sms' is a channel like 'rcs': an sms trigger queues sms rows whose
-- dedupe key ends in '|sms'; a row's template and consent are its own
-- channel's (no cross-channel fallback, either way); an sms template's
-- name is an optional label. The gateway's delivery pushes are matched
-- by user_id suffix and the number's last nine digits, a later delivery
-- report by the stored ref_id (else by number within 48 h), and an
-- inbound STOP finds the contact of the newest sent sms to that number.
-- The receipt functions are service role only.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. Fixtures are
-- rolled back by a sentinel exception; failures are named in the final
-- one.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000226001';  -- owner of A (admin)
  u_lead  UUID := '00000000-0000-4000-8000-000000226002';  -- agent, recruiter lead
  a_acct  UUID;
  k1 UUID; k2 UUID;  -- contacts (k1 saved in local format)
  v1 UUID; v2 UUID;  -- conversations
  o_sms UUID;        -- v1's sms stage_ai_interview row
  d1 UUID; d2 UUID; d3 UUID; d_wa UUID;  -- sent rows on v2
  h_id BIGINT;
  j    JSONB;
  r    TEXT;
  c    TEXT[] := '{}';  -- one element per check: NULL = passed
  failed TEXT[];
  n    INT := 0;
BEGIN
  BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_as(p_uid uuid, p_sql text)
    RETURNS text LANGUAGE plpgsql AS $body$
    DECLARE v text; st text; h text; m text;
    BEGIN
      BEGIN
        IF p_uid IS NULL THEN
          PERFORM set_config('request.jwt.claim.sub', '', true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('role', 'service_role')::text, true);
          SET LOCAL ROLE service_role;
        ELSE
          PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
          PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
        END IF;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN coalesce(nullif(v, ''), 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT,
                                m = MESSAGE_TEXT;
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
        PERFORM set_config('request.jwt.claims', '', true);
        RETURN format('ERROR %s %s: %s', st, coalesce(h, ''), m);
      END;
    END $body$
  $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_chk(p_label text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_label || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;

  -- ---------- Fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'sms-owner@example.invalid'),
    (u_lead,  'sms-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_lead;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '0502260001', 'Sms One') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971502260002', 'Sms Two') RETURNING id INTO k2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k1, u_lead) RETURNING id INTO v1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k2, u_lead) RETURNING id INTO v2;

  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, true, 20)::text');
  IF r NOT LIKE 'ok{%' THEN RAISE EXCEPTION 'fixture: member/settings %', r; END IF;

  -- ---------- trigger_set and enqueue ----------
  r := pg_temp.hr_as(u_lead,
         'SELECT public.hr_automsg_trigger_set(''stage_ai_interview'', true, NULL, p_channel => ''sms'')::text');
  r := left(r, 1) || '/' || (SELECT t.channel FROM hr_automsg_triggers t
                              WHERE t.account_id = a_acct AND t.trigger = 'stage_ai_interview');
  c := c || pg_temp.hr_chk('trigger_set p_channel sms was not stored', r, '{/sms');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''cv_received'', true, NULL, ''fax'')::text');
  c := c || pg_temp.hr_chk('trigger_set with a bogus channel was not INVALID', r, 'ERROR % INVALID:%');

  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v1));
  IF r <> 'cv_review' THEN RAISE EXCEPTION 'fixture: hr_open v1 %', r; END IF;
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''ok'')).stage_key', v1));
  IF r <> 'ai_interview' THEN RAISE EXCEPTION 'fixture: hr_set_stage v1 %', r; END IF;
  SELECT o.id INTO o_sms FROM hr_automsg_outbox o
   WHERE o.conversation_id = v1 AND o.trigger = 'stage_ai_interview';
  SELECT h.id INTO h_id FROM hr_stage_history h
   WHERE h.conversation_id = v1 AND h.to_stage = 'ai_interview' ORDER BY h.id DESC LIMIT 1;
  r := (SELECT concat_ws('/', o.channel, o.status, o.dedupe_key = 'hist:' || h_id || '|sms')
          FROM hr_automsg_outbox o WHERE o.id = o_sms);
  c := c || pg_temp.hr_chk('an sms trigger''s stage event did not queue an sms row keyed hist:<id>|sms', r,
                           'sms/queued/t');
  r := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.hr_automsg_enqueue_nudges(timestamptz)'::regprocedure);
  c := c || pg_temp.hr_chk('nudges do not key an sms row with |sms', r, '%IN (''rcs'', ''sms'') THEN ''|'' || t.channel%');

  -- ---------- template_set: SMS rules ----------
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''ai_interview_invite'', ''en'','
         || ' ''Hi {name}, see you at {slot}'', ''ai_invite_wa'', ''approved'')::text')
    || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''ai_interview_invite'', ''en'','
         || ' ''Hi {name} (rcs)'', ''Rcs.1'', ''approved'', ''utility'', ''rcs'')::text');
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_sms))::jsonb;
  r := concat_ws('/', j->>'channel', jsonb_typeof(j->'template'));
  c := c || pg_temp.hr_chk('an sms row took the WhatsApp or RCS template', r, 'sms/null');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''ai_interview_invite'', ''en'','
         || ' ''Hi {name}, interview at {slot}'', '''', ''approved'', ''utility'', ''sms'')::text');
  c := c || pg_temp.hr_chk('an approved sms template with no label was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''ai_interview_invite'', ''en'','
         || ' ''Hi {name}, interview at {slot}'', ''AI-invite.SMS'', ''approved'', ''utility'', ''sms'')::text');
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_sms))::jsonb;
  r := left(r, 1) || '/' || concat_ws('/', j->'template'->>'meta_template_name', j->'template'->>'body');
  c := c || pg_temp.hr_chk('an approved sms template with a label was refused, or the row did not take it', r,
                           '{/AI-invite.SMS/Hi {name}, interview at {slot}');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''cv ack'', ''draft'', ''utility'', ''sms'')::text');
  c := c || pg_temp.hr_chk('an sms label with a space was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''Cv.Ack:1'', ''draft'', ''utility'', ''sms'')::text');
  c := c || pg_temp.hr_chk('an sms label in the RCS characters was refused', left(r, 1), '{');
  r := (SELECT string_agg(x.channel, ',' ORDER BY x.channel) FROM hr_automsg_templates x
         WHERE x.account_id = a_acct AND x.kind = 'ai_interview_invite' AND x.language = 'en');
  c := c || pg_temp.hr_chk('the three channels'' templates do not sit side by side', r, 'rcs,sms,whatsapp');

  -- ---------- consent: per channel ----------
  r := pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true)', v1))
    || '/' || pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true, ''form'', ''rcs'')', v1))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o_sms));
  c := c || pg_temp.hr_chk('WhatsApp and RCS consent let the sms row be claimed', r, 'true/true/lost');
  r := pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true, ''recruiter_confirmed'', ''sms'')', v1))
    || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o_sms));
  c := c || pg_temp.hr_chk('an SMS consent did not let the sms row be claimed', r, 'true/claimed');
  r := pg_temp.hr_as(NULL, format(
         'SELECT concat_ws(''/'', x.status, x.provider_message_id) FROM public.hr_automsg_mark(%L, ''sent'', NULL, ''T9:1234567'', NULL) x', o_sms));
  c := c || pg_temp.hr_chk('mark sent of an sms row', r, 'sent/T9:1234567');

  -- ---------- Receipts: sms_result by user id and number tail ----------
  -- k1 is saved as 05…, the gateway reports +9715…: the same nine-digit tail.
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''1234567'', ''+971502260001'', ''sent'', now(), NULL)', a_acct));
  r := r || '/' || (SELECT coalesce(o.delivery_state, 'none') FROM hr_automsg_outbox o WHERE o.id = o_sms);
  c := c || pg_temp.hr_chk('an sms_result did not match by user id and number tail', r, 'recorded/sent');
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''1234567'', ''+971502269999'', ''delivered'', now(), NULL)', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''234567'', ''+971502260001'', ''delivered'', now(), NULL)', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''12x'', ''+971502260001'', ''delivered'', now(), NULL)', a_acct));
  c := c || pg_temp.hr_chk('another number or a user id that is only a suffix matched, or a bad id was accepted', r,
                           'unknown_message/unknown_message/ERROR % INVALID:%');
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''1234567'', ''971502260001'', ''delivered'', now(), NULL)', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''1234567'', ''971502260001'', ''sent'', now(), NULL)', a_acct));
  r := r || '/' || (SELECT o.delivery_state FROM hr_automsg_outbox o WHERE o.id = o_sms);
  c := c || pg_temp.hr_chk('delivery did not move forward only', r, 'recorded/unchanged/delivered');

  -- ---------- ref ids ----------
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_ref_record(%L, ''1234567'', ''+971502260001'', ''R-1'')', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_ref_record(%L, ''1234567'', ''+971502260001'', ''R-1'')', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_ref_record(%L, ''1234567'', ''+971502260001'', ''R-2'')', a_acct));
  -- The writes first, their effect in a separate statement (snapshot).
  r := r || '/' || coalesce((SELECT o.sms_ref_id FROM hr_automsg_outbox o WHERE o.id = o_sms), 'none');
  c := c || pg_temp.hr_chk('ref ids are not stored once and kept', r, 'stored/unchanged/conflict/R-1');
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_ref_record(%L, ''1234567'', ''+971502260001'', ''a b'')', a_acct));
  c := c || pg_temp.hr_chk('a ref id with a space was not INVALID', r, 'ERROR % INVALID:%');

  -- ---------- Later delivery reports: by ref, else by number ----------
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel, created_at)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v226:d1|sms', 'sent', 'T1:111', now() - interval '2 hours', 'sms',
          now() - interval '2 hours')
  RETURNING id INTO d1;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel, created_at, sms_ref_id)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v226:d2|sms', 'sent', 'T2:222', now() - interval '1 hour', 'sms',
          now() - interval '1 hour', 'R-77')
  RETURNING id INTO d2;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel, created_at)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v226:d3|sms', 'sent', 'T3:333', now() - interval '49 hours', 'sms',
          now() - interval '49 hours')
  RETURNING id INTO d3;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel, created_at)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v226:dwa', 'sent', 'T2:222', now(), 'whatsapp', now())
  RETURNING id INTO d_wa;

  BEGIN
    UPDATE hr_automsg_outbox SET sms_ref_id = 'X' WHERE id = d_wa;
    r := CASE WHEN FOUND THEN 'written' ELSE 'no whatsapp row' END;
  EXCEPTION WHEN check_violation THEN
    r := 'refused';
  END;
  c := c || pg_temp.hr_chk('a ref id on a WhatsApp row was not refused', r, 'refused');

  -- By ref: R-77 is d2's, though d1 is the newer ref-less row.
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_dlr_record(%L, ''R-77'', ''+971502260002'', ''failed'', now(), ''65'')', a_acct));
  r := r || '/' || (SELECT concat_ws(':', o.delivery_state, o.status, o.last_error) FROM hr_automsg_outbox o WHERE o.id = d2)
    || '/' || (SELECT coalesce(o.delivery_state, 'none') FROM hr_automsg_outbox o WHERE o.id = d1);
  c := c || pg_temp.hr_chk('a permanent failure by ref did not fail that row for good (and only it)', r,
                           'failed_terminal/failed:failed:delivery_failed:65/none');
  -- No ref match: the newest ref-less sms row to the number within 48 h.
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_dlr_record(%L, ''R-unknown'', ''+971502260002'', ''delivered'', now(), NULL)', a_acct));
  r := r || '/' || (SELECT coalesce(o.delivery_state, 'none') FROM hr_automsg_outbox o WHERE o.id = d1)
    || '/' || (SELECT coalesce(o.delivery_state, 'none') FROM hr_automsg_outbox o WHERE o.id = d3);
  c := c || pg_temp.hr_chk('a report with no known ref did not fall back to the recent ref-less row', r,
                           'recorded/delivered/none');
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_sms_dlr_record(%L, NULL, ''+971502260002'', ''delivered'', now(), NULL)', a_acct));
  r := r || '/' || (SELECT coalesce(o.delivery_state, 'none') FROM hr_automsg_outbox o WHERE o.id = d3);
  c := c || pg_temp.hr_chk('a report reached a row sent over 48 hours ago', r, 'unknown_message/none');
  r := (SELECT coalesce(o.delivery_state, 'none') FROM hr_automsg_outbox o WHERE o.id = d_wa);
  c := c || pg_temp.hr_chk('an sms report touched a WhatsApp row with the same provider id', r, 'none');

  -- delivery_record with p_channel 'sms' (by provider id) and the ladder.
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''T3:333'', ''sent'', now(), NULL, ''sms'')', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''T3:333'', ''delivered'', now(), NULL)', a_acct));
  r := r || '/' || (SELECT o.delivery_state FROM hr_automsg_outbox o WHERE o.id = d3);
  c := c || pg_temp.hr_chk('delivery_record did not take p_channel sms, or a WhatsApp receipt reached an sms row', r,
                           'recorded/unknown_message/sent');

  -- ---------- STOP: the contact of the newest sent sms to the number ----------
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_sms_contact(%L, ''+971 50 226 0001'')::text', a_acct));
  c := c || pg_temp.hr_chk('sms_contact did not find the texted contact', r, k1::text);
  r := pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_sms_contact(%L, ''+971502269999'')::text, ''none'')', a_acct))
    || '/' || pg_temp.hr_as(NULL, format('SELECT coalesce(public.hr_automsg_sms_contact(%L, ''12345'')::text, ''none'')', a_acct));
  c := c || pg_temp.hr_chk('sms_contact named someone for an unknown or short number', r, 'none/none');

  -- ---------- Daily count spans every channel ----------
  -- By difference, so the account's time zone and the hour do not matter.
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', d1))::jsonb;
  n := (j->>'sent_today')::int;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v226:d4|sms', 'sent', 'T4:444', now(), 'sms');
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', d1))::jsonb;
  r := ((j->>'sent_today')::int - n)::text;
  c := c || pg_temp.hr_chk('an sms sent today does not count toward the daily cap', r, '1');

  -- ---------- Privileges ----------
  r := pg_temp.hr_as(u_owner, format(
         'SELECT public.hr_automsg_sms_delivery_record(%L, ''1234567'', ''+971502260001'', ''sent'', now(), NULL)', a_acct))
    || '/' || pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_sms_contact(%L, ''+971502260001'')::text', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_apply(%L, ''sent'', now(), NULL)', d1));
  c := c || pg_temp.hr_chk('a signed-in user or the service role reached an internal receipt function', r,
                           'ERROR 42501 %/ERROR 42501 %/ERROR 42501 %');

  RAISE EXCEPTION 'verify-hr-automsg-sms rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-automsg-sms: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-automsg-sms: all % checks passed', n;
END
$verify$;
