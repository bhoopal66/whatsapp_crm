-- Behavioural regression suite for the RCS channel of HR automated
-- messages (migration 215).
--
-- Every trigger, template, consent and outbox row belongs to one
-- channel ('whatsapp' | 'rcs'), WhatsApp by default. An rcs trigger
-- queues rcs rows whose dedupe key ends in '|rcs'; a row's template and
-- consent are its own channel's (no cross-channel fallback), while the
-- contact's opt-out and the daily count span every channel; receipts
-- match a provider id within one channel. The admin RPCs take and show
-- the channel. verify-hr-automsg.sql and verify-hr-automsg-delivery.sql
-- exercise only the WhatsApp defaults; this file covers the RCS
-- branches through the real RPCs and triggers.
--
-- ONE statement on purpose: `supabase db query --file` sends the file
-- as a single prepared statement and rejects several. The CLI drops
-- NOTICE output, so failing assertions are named in the final
-- exception. The fixtures are rolled back on success too: the checks
-- run inside a block that ends by raising a sentinel, which undoes
-- every write while the collected results (plpgsql variables) survive.

DO $verify$
DECLARE
  u_owner UUID := '00000000-0000-4000-8000-000000215001';  -- owner of A (admin)
  u_lead  UUID := '00000000-0000-4000-8000-000000215002';  -- agent, recruiter lead
  a_acct  UUID;
  k1 UUID; k2 UUID;  -- contacts
  v1 UUID; v2 UUID;  -- conversations
  o_wa  UUID;        -- v1's WhatsApp cv_received row
  o_rcs UUID;        -- v1's rcs stage_ai_interview row
  o_held UUID;       -- v2's queued rcs row, held channel_not_connected
  d_wa UUID; d_rcs UUID;  -- v2's sent rows sharing one provider id
  h_id    BIGINT;
  j       JSONB;
  r       TEXT;
  c       TEXT[] := '{}';  -- one element per check: NULL = passed
  failed  TEXT[];
  n       INT := 0;
BEGIN
  BEGIN
  -- Run a statement as a signed-in user (p_uid) or, with p_uid NULL, as
  -- the service role with no user: the value / 'ok', or
  -- 'ERROR <sqlstate> <hint>: <message>'.
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
        RETURN coalesce(nullif(v, ''), 'ok');  -- a void RPC casts to ''
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

  -- NULL when `got` matches the LIKE pattern, else the named failure.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hr_chk(p_label text, p_got text, p_want text)
    RETURNS text LANGUAGE sql AS $body$
      SELECT CASE WHEN p_got LIKE p_want THEN NULL
                  ELSE p_label || ' (got ' || left(coalesce(p_got, '<null>'), 200) || ')' END
    $body$
  $fn$;

  -- ---------- Fixture ----------
  INSERT INTO auth.users (id, email) VALUES
    (u_owner, 'rcs-owner@example.invalid'),
    (u_lead,  'rcs-lead@example.invalid')
  ON CONFLICT DO NOTHING;
  SELECT id INTO a_acct FROM accounts WHERE owner_user_id = u_owner;
  IF a_acct IS NULL THEN
    RAISE EXCEPTION 'fixture: auth.users trigger did not provision an account';
  END IF;
  UPDATE profiles SET account_id = a_acct, account_role = 'agent' WHERE user_id = u_lead;

  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971502150001', 'Rcs One') RETURNING id INTO k1;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (a_acct, u_owner, '971502150002', 'Rcs Two') RETURNING id INTO k2;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k1, u_lead) RETURNING id INTO v1;
  INSERT INTO conversations (account_id, user_id, contact_id, assigned_agent_id)
  VALUES (a_acct, u_owner, k2, u_lead) RETURNING id INTO v2;

  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_member_set(%L, ''recruiter'', ''lead'')', u_lead))
    || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_settings_set(false, NULL, NULL, NULL, true, 20)::text');
  IF r NOT LIKE 'ok{%' THEN RAISE EXCEPTION 'fixture: member/settings %', r; END IF;

  -- ---------- trigger_set: channel ----------
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''cv_received'', true)::text');
  r := pg_temp.hr_as(u_lead,
         'SELECT public.hr_automsg_trigger_set(''stage_ai_interview'', true, NULL, p_channel => ''rcs'')::text');
  j := r::jsonb;
  r := (SELECT e->>'channel' FROM jsonb_array_elements(j->'triggers') e
         WHERE e->>'trigger' = 'stage_ai_interview')
    || '/' || (SELECT string_agg(t.trigger || ':' || t.channel, ',' ORDER BY t.trigger)
                 FROM hr_automsg_triggers t WHERE t.account_id = a_acct);
  c := c || pg_temp.hr_chk('trigger_set p_channel rcs was not stored', r,
                           'rcs/cv_received:whatsapp,stage_ai_interview:rcs');
  r := (SELECT a.detail->>'channel' FROM hr_automsg_audit a
         WHERE a.account_id = a_acct AND a.action = 'trigger'
           AND a.detail->>'trigger' = 'stage_ai_interview' ORDER BY a.id DESC LIMIT 1);
  c := c || pg_temp.hr_chk('the trigger audit row does not hold the channel', r, 'rcs');
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''stage_ai_interview'', true, NULL, NULL)::text');
  r := (SELECT t.channel FROM hr_automsg_triggers t
         WHERE t.account_id = a_acct AND t.trigger = 'stage_ai_interview');
  c := c || pg_temp.hr_chk('trigger_set with a NULL channel did not keep rcs', r, 'rcs');
  n := (SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct);
  r := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_trigger_set(''cv_received'', false, NULL, ''sms'')::text');
  r := r || '/' || (SELECT concat_ws(':', t.enabled, t.channel) FROM hr_automsg_triggers t
                     WHERE t.account_id = a_acct AND t.trigger = 'cv_received')
    || '/' || ((SELECT count(*) FROM hr_automsg_audit a WHERE a.account_id = a_acct) - n);
  c := c || pg_temp.hr_chk('trigger_set with a bogus channel was not INVALID or wrote something', r,
                           'ERROR % INVALID:%/t:whatsapp/0');

  -- ---------- Enqueue: channel and dedupe key ----------
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v1));
  IF r <> 'cv_review' THEN RAISE EXCEPTION 'fixture: hr_open v1 %', r; END IF;
  SELECT o.id INTO o_wa FROM hr_automsg_outbox o WHERE o.conversation_id = v1 AND o.trigger = 'cv_received';
  r := (SELECT concat_ws('/', o.channel, o.dedupe_key = 'hist:' || h.id)
          FROM hr_automsg_outbox o
          JOIN hr_stage_history h ON h.conversation_id = o.conversation_id AND h.event = 'open'
         WHERE o.id = o_wa);
  c := c || pg_temp.hr_chk('a WhatsApp trigger''s row is not whatsapp with an unsuffixed key', r, 'whatsapp/t');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_set_stage(%L, ''ai_interview'', ''ok'')).stage_key', v1));
  IF r <> 'ai_interview' THEN RAISE EXCEPTION 'fixture: hr_set_stage v1 %', r; END IF;
  SELECT o.id INTO o_rcs FROM hr_automsg_outbox o
   WHERE o.conversation_id = v1 AND o.trigger = 'stage_ai_interview';
  SELECT h.id INTO h_id FROM hr_stage_history h
   WHERE h.conversation_id = v1 AND h.to_stage = 'ai_interview' ORDER BY h.id DESC LIMIT 1;
  r := (SELECT concat_ws('/', o.channel, o.template_kind, o.status, o.dedupe_key = 'hist:' || h_id || '|rcs')
          FROM hr_automsg_outbox o WHERE o.id = o_rcs);
  c := c || pg_temp.hr_chk('an rcs trigger''s stage event did not queue an rcs row keyed hist:<id>|rcs', r,
                           'rcs/ai_interview_invite/queued/t');

  -- ---------- row_state: channel and template ----------
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_rcs));
  j := r::jsonb;
  r := concat_ws('/', j->>'channel', j->'row'->>'channel', jsonb_typeof(j->'template'));
  c := c || pg_temp.hr_chk('row_state of an rcs row with no template', r, 'rcs/rcs/null');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''ai_interview_invite'', ''en'','
         || ' ''Hi {name}, see you at {slot}'', ''ai_invite_wa'', ''approved'')::text');
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_rcs))::jsonb;
  r := left(r, 1) || '/' || jsonb_typeof(j->'template');
  c := c || pg_temp.hr_chk('an rcs row took the WhatsApp template', r, '{/null');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''ai_interview_invite'', ''en'','
         || ' ''Hi {name} (rcs)'', ''Abc.1:x-y'', ''approved'', ''utility'', ''rcs'')::text');
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_rcs))::jsonb;
  r := left(r, 1) || '/' || concat_ws('/', j->'template'->>'meta_template_name', j->'template'->>'body');
  c := c || pg_temp.hr_chk('an rcs row did not take its RCS template (Abc.1:x-y accepted)', r,
                           '{/Abc.1:x-y/Hi {name} (rcs)');
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_wa))::jsonb;
  r := concat_ws('/', j->>'channel', jsonb_typeof(j->'template'));
  c := c || pg_temp.hr_chk('row_state of a WhatsApp row (cv_ack, no template)', r, 'whatsapp/null');

  -- ---------- template_set: RCS rules ----------
  r := (SELECT string_agg(x.channel || ':' || x.meta_template_name, ',' ORDER BY x.channel)
          FROM hr_automsg_templates x
         WHERE x.account_id = a_acct AND x.kind = 'ai_interview_invite' AND x.language = 'en');
  c := c || pg_temp.hr_chk('the RCS template does not sit beside the WhatsApp one', r,
                           'rcs:Abc.1:x-y,whatsapp:ai_invite_wa');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''a b'', ''draft'', ''utility'', ''rcs'')::text');
  c := c || pg_temp.hr_chk('an RCS id with a space was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''a/b'', ''approved'', ''utility'', ''rcs'')::text');
  c := c || pg_temp.hr_chk('an RCS id with a slash was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', %L, ''draft'', ''utility'', ''rcs'')::text', repeat('a', 513)));
  c := c || pg_temp.hr_chk('a 513-character RCS id was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, format('SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', %L, ''draft'', ''utility'', ''rcs'')::text', repeat('a', 512)));
  c := c || pg_temp.hr_chk('a 512-character RCS id was refused', left(r, 1), '{');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''ar'', ''Hi'', '''', ''approved'', ''utility'', ''rcs'')::text');
  c := c || pg_temp.hr_chk('an approved RCS template with an empty id was not INVALID', r, 'ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''reply_nudge'', ''ar'', ''Hi'', NULL, ''draft'', ''utility'', ''rcs'')::text');
  r := left(r, 1) || '/' || (SELECT concat_ws(':', x.channel, x.meta_template_name = '', x.approval_status)
                              FROM hr_automsg_templates x
                             WHERE x.account_id = a_acct AND x.kind = 'reply_nudge' AND x.language = 'ar');
  c := c || pg_temp.hr_chk('an RCS draft with an empty id was not accepted', r, '{/rcs:t:draft');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''Abc'', ''draft'')::text')
    || '/' || pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''Abc'', ''approved'', ''utility'', ''whatsapp'')::text');
  c := c || pg_temp.hr_chk('a WhatsApp template name in upper case was not INVALID', r,
                           'ERROR % INVALID:%/ERROR % INVALID:%');
  r := pg_temp.hr_as(u_owner, 'SELECT public.hr_automsg_template_set(''cv_ack'', ''en'', ''Hi'', ''x'', ''draft'', ''utility'', ''sms'')::text');
  c := c || pg_temp.hr_chk('template_set with a bogus channel was not INVALID', r, 'ERROR % INVALID:%');
  r := (SELECT a.detail->>'channel' FROM hr_automsg_audit a
         WHERE a.account_id = a_acct AND a.action = 'template'
           AND a.detail->>'meta_template_name' = 'Abc.1:x-y');
  c := c || pg_temp.hr_chk('the template audit row does not hold the channel', r, 'rcs');

  -- ---------- consent: per channel ----------
  r := pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true)', v1));
  r := r || '/' || coalesce(pg_temp.hr_as(u_lead,
         format('SELECT coalesce(granted::text, ''none'') FROM public.hr_automsg_consent_get(%L, ''rcs'')', v1)), '');
  c := c || pg_temp.hr_chk('a WhatsApp consent shows on rcs', r, 'true/none');
  r := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o_rcs));
  c := c || pg_temp.hr_chk('a WhatsApp consent let the rcs row be claimed', r, 'lost');
  r := pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true, ''recruiter_confirmed'', ''rcs'')', v1));
  r := r || '/' || pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_claim(%L)', o_rcs));
  c := c || pg_temp.hr_chk('an RCS consent did not let the rcs row be claimed', r, 'true/claimed');
  r := (SELECT a.detail->>'channel' FROM hr_automsg_audit a
         WHERE a.account_id = a_acct AND a.action = 'consent' ORDER BY a.id DESC LIMIT 1);
  c := c || pg_temp.hr_chk('the consent audit row does not hold the channel', r, 'rcs');
  r := pg_temp.hr_as(u_lead, format('SELECT (public.hr_open(%L, ''candidate'')).stage_key', v2));
  IF r <> 'cv_review' THEN RAISE EXCEPTION 'fixture: hr_open v2 %', r; END IF;
  r := pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true, ''form'', ''rcs'')', v2));
  r := r || '/' || pg_temp.hr_as(u_lead,
         format('SELECT coalesce(granted::text, ''none'') FROM public.hr_automsg_consent_get(%L)', v2))
    || '/' || pg_temp.hr_as(u_lead,
         format('SELECT coalesce(granted::text, ''none'') FROM public.hr_automsg_consent_get(%L, ''whatsapp'')', v2));
  c := c || pg_temp.hr_chk('an RCS consent shows on WhatsApp', r, 'true/none/none');
  r := pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_set(%L, true, ''form'', ''sms'')', v2))
    || '/' || pg_temp.hr_as(u_lead, format('SELECT granted FROM public.hr_automsg_consent_get(%L, ''sms'')', v2))
    || '/' || (SELECT count(*) FROM hr_automsg_consent k WHERE k.account_id = a_acct AND k.contact_id = k2);
  c := c || pg_temp.hr_chk('consent with a bogus channel was not INVALID or wrote a row', r,
                           'ERROR % INVALID:%/ERROR % INVALID:%/1');

  -- ---------- mark: sent with no message id, held channel_not_connected ----------
  r := pg_temp.hr_as(NULL, format(
         'SELECT concat_ws(''/'', x.status, x.message_id IS NULL, x.provider_message_id, x.claim_state IS NULL)'
         ' FROM public.hr_automsg_mark(%L, ''sent'', NULL, ''rcs-msg-1'', NULL) x', o_rcs));
  c := c || pg_temp.hr_chk('mark sent with a NULL message id', r, 'sent/t/rcs-msg-1/t');
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, channel)
  VALUES (a_acct, v2, k2, 'stage_ai_interview', 'ai_interview_invite', 'v215:held|rcs', 'queued', 'rcs')
  RETURNING id INTO o_held;
  r := pg_temp.hr_as(NULL, format(
         'SELECT concat_ws(''/'', x.status, x.hold_reason) FROM public.hr_automsg_mark(%L, ''held'', ''channel_not_connected'') x',
         o_held));
  c := c || pg_temp.hr_chk('mark held channel_not_connected', r, 'held/channel_not_connected');

  -- ---------- outbox_list: channel last ----------
  r := pg_temp.hr_as(u_lead, format(
         'SELECT string_agg(l.channel, '','' ORDER BY l.channel) FROM public.hr_automsg_outbox_list(NULL, 500) l'
         ' WHERE l.id IN (%L, %L)', o_rcs, o_wa));
  c := c || pg_temp.hr_chk('outbox_list does not carry each row''s channel', r, 'rcs,whatsapp');
  r := (SELECT (p.proargnames)[array_length(p.proargnames, 1)] FROM pg_proc p
         WHERE p.oid = 'public.hr_automsg_outbox_list(text,integer)'::regprocedure);
  c := c || pg_temp.hr_chk('outbox_list''s last column is not channel', r, 'channel');

  -- ---------- Receipts within one channel ----------
  -- Two sent rows on v2 share a provider id; the WhatsApp one is newer,
  -- so a match that ignored the channel would land on it.
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel, created_at)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v215:d|rcs', 'sent', 'shared-1', now(), 'rcs',
          now() - interval '1 minute')
  RETURNING id INTO d_rcs;
  INSERT INTO hr_automsg_outbox (account_id, conversation_id, contact_id, trigger, template_kind,
                                 dedupe_key, status, provider_message_id, sent_at, channel, created_at)
  VALUES (a_acct, v2, k2, 'cv_received', 'cv_ack', 'v215:d', 'sent', 'shared-1', now(), 'whatsapp', now())
  RETURNING id INTO d_wa;
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''shared-1'', ''delivered'', now(), NULL, p_channel => ''rcs'')', a_acct));
  r := r || '/' || (SELECT concat_ws(':', coalesce(x.delivery_state, 'none'), coalesce(y.delivery_state, 'none'))
                      FROM hr_automsg_outbox x, hr_automsg_outbox y WHERE x.id = d_rcs AND y.id = d_wa);
  c := c || pg_temp.hr_chk('an rcs receipt did not touch only the rcs row', r, 'recorded/delivered:none');
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''shared-1'', ''read'', now(), NULL)', a_acct));
  r := r || '/' || (SELECT concat_ws(':', coalesce(x.delivery_state, 'none'), coalesce(y.delivery_state, 'none'))
                      FROM hr_automsg_outbox x, hr_automsg_outbox y WHERE x.id = d_rcs AND y.id = d_wa);
  c := c || pg_temp.hr_chk('a default (WhatsApp) receipt did not touch only the WhatsApp row', r, 'recorded/delivered:read');
  r := pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''rcs-msg-1'', ''delivered'', now(), NULL)', a_acct))
    || '/' || pg_temp.hr_as(NULL, format(
         'SELECT public.hr_automsg_delivery_record(%L, ''rcs-msg-1'', ''delivered'', now(), NULL, ''sms'')', a_acct));
  c := c || pg_temp.hr_chk('a WhatsApp receipt matched an rcs-only id, or a bogus channel was accepted', r,
                           'unknown_message/ERROR % INVALID:%');

  -- ---------- Daily count spans both channels ----------
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_held))::jsonb;
  r := (j->>'sent_today') || '/' || (SELECT string_agg(o.channel, ',' ORDER BY o.channel) FROM hr_automsg_outbox o
                                       WHERE o.contact_id = k2 AND o.status = 'sent');
  c := c || pg_temp.hr_chk('the daily count does not span both channels', r, '2/rcs,whatsapp');

  -- ---------- config: channel on every entry ----------
  j := pg_temp.hr_as(u_lead, 'SELECT public.hr_automsg_config()::text')::jsonb;
  r := (SELECT concat_ws('/', count(*), count(*) FILTER (WHERE e ? 'channel'),
                         string_agg(e->>'trigger' || ':' || (e->>'channel'), ',' ORDER BY e->>'trigger')
                           FILTER (WHERE e->>'trigger' IN ('interview_reminder', 'stage_ai_interview')))
          FROM jsonb_array_elements(j->'triggers') e);
  c := c || pg_temp.hr_chk('config triggers do not all carry a channel (whatsapp with no row)', r,
                           '6/6/interview_reminder:whatsapp,stage_ai_interview:rcs');
  r := (SELECT concat_ws('/', count(*) = count(*) FILTER (WHERE e ? 'channel'),
                         count(*) FILTER (WHERE e->>'channel' = 'rcs'),
                         count(*) FILTER (WHERE e->>'channel' = 'whatsapp'))
          FROM jsonb_array_elements(j->'templates') e);
  c := c || pg_temp.hr_chk('config templates do not all carry a channel, rcs rows included', r, 't/3/1');

  -- ---------- Opt-out stops every channel ----------
  UPDATE contacts SET opted_out_at = now() WHERE id = k1;
  j := pg_temp.hr_as(NULL, format('SELECT public.hr_automsg_row_state(%L)::text', o_rcs))::jsonb;
  r := concat_ws('/', j->>'channel', j->>'opted_out');
  c := c || pg_temp.hr_chk('an opt-out does not show on an rcs row', r, 'rcs/true');

  RAISE EXCEPTION 'verify-hr-automsg-rcs rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;

  n := cardinality(c);
  SELECT array_agg(x) INTO failed FROM unnest(c) x WHERE x IS NOT NULL;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-automsg-rcs: % of % checks failed: %', cardinality(failed), n,
      array_to_string(failed, ' | ');
  END IF;
  RAISE NOTICE 'verify-hr-automsg-rcs: all % checks passed', n;
END
$verify$;
