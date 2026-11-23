-- ============================================================
-- 289: small access points left by the security audits.
--
--  1. Case desk. An uploader could attach to a company they have no case
--     of by typing its licence, or join another person's open case; now
--     the upload waits for a sorter (COMPANY_RESTRICTED). The company's
--     contacts and cases are shown as far as the reader may see them.
--  2. chat_add_members: only channel admins add to a private channel,
--     bank guests included.
--  3. webhook_endpoints: made in one's own name; a session never moves
--     created_by, account_id or the secret.
--  4. quick_replies: written in one's own name, the author is kept.
--  5. recycle_excluded_among: only contacts the caller can see.
--  6. team_activity_start_check: only a chat the caller can see.
--  7. acknowledge_insight_attention, dismiss_tag_suggestion: a personal
--     chat follows can_view_personal_chat (hr_can_see's rule).
--  8. deal_room_roster: a name holding the number in local form is masked.
--  9. chat_insert_attachments: the file is the poster's own upload.
-- 10. The rate card is the members'; filter_contacts_by_tags is not anon's.
--
-- Functions where a line changes are patched from the installed body
-- (278, 286). Every target is looked for before any DDL: a missing one
-- refuses and changes nothing. Re-runnable; apply after 288.
-- ============================================================

SET lock_timeout = '5s';

-- The body of `fn` with `old` replaced, or NULL when `new` is there already.
CREATE OR REPLACE FUNCTION pg_temp.p289(def text, fn text, old text, new text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF strpos(def, new) > 0 THEN
    RETURN def;
  END IF;
  IF (length(def) - length(replace(def, old, ''))) <> length(old) THEN
    RAISE EXCEPTION '289: % does not read as expected (%); nothing was changed', fn, left(old, 60);
  END IF;
  RETURN replace(def, old, new);
END $$;

DO $do$
DECLARE
  d       text;
  v_defs  text[] := '{}';
  v_fn    text;
  v_see   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '289 must be applied by a superuser or BYPASSRLS role (its functions read RLS tables)';
  END IF;

  -- ---------- 1. case desk ----------
  v_fn := 'intake_route';
  d := pg_get_functiondef('public.intake_route(uuid, uuid, timestamptz)'::regprocedure);
  d := pg_temp.p289(d, v_fn, E'  v_reason text;\nBEGIN', E'  v_reason text;\n  v_known  uuid;  -- 289\nBEGIN');
  d := pg_temp.p289(d, v_fn, E'  v_bank := i.bank_code;\n',
    E'  v_bank := i.bank_code;\n'
    '  SELECT cu.id INTO v_known FROM public.desk_customers cu\n'
    '   WHERE cu.account_id = i.account_id AND cu.merged_into IS NULL\n'
    '     AND cu.trade_licence_no = public.desk_normalise_licence(i.trade_licence_no);\n');
  d := pg_temp.p289(d, v_fn, E'      v_reason := ''CASE_EXISTS_NAME_MISMATCH'';\n    ELSE\n',
    E'      v_reason := ''CASE_EXISTS_NAME_MISMATCH'';\n'
    '    -- 289: a company the uploader has no case of is a sorter''s to join.\n'
    '    ELSIF v_known IS NOT NULL AND NOT public.desk_customer_can_read(i.uploaded_by, i.account_id, v_known) THEN\n'
    '      v_reason := ''COMPANY_RESTRICTED'';\n'
    '    ELSE\n');
  d := pg_temp.p289(d, v_fn, E'                                     i.contact_id, i.uploaded_by, NULL, p_now) o;\n',
    E'                                     i.contact_id, i.uploaded_by, NULL, p_now) o;\n'
    '        -- 289: an open case of a contact the uploader cannot see, or a\n'
    '        -- company someone else created while this call ran.\n'
    '        IF (NOT v_created AND NOT public.memory_can_read(i.uploaded_by, i.account_id, ''contact'', i.contact_id))\n'
    '           OR (v_known IS NULL AND EXISTS (SELECT 1 FROM public.desk_customers cu\n'
    '                 WHERE cu.id = v_cust AND cu.created_by IS DISTINCT FROM i.uploaded_by)) THEN\n'
    '          PERFORM public.desk_refuse(''intake_route'', ''COMPANY_RESTRICTED'', ''a sorter files this upload'');\n'
    '        END IF;\n');
  v_defs := v_defs || d;

  v_fn := 'desk_customer_contacts_list';
  d := pg_get_functiondef('public.desk_customer_contacts_list(uuid, uuid, uuid)'::regprocedure);
  d := pg_temp.p289(d, v_fn, E'  SELECT l.contact_id, c.name, c.phone, l.role,',
    E'  -- 289: of a contact the reader may not see, no phone and only the\n'
    '  -- first word of the name (none when that is itself a number).\n'
    '  SELECT l.contact_id,\n'
    '         CASE WHEN s.ok THEN c.name\n'
    '              WHEN char_length(regexp_replace(s.word, ''\\D'', '''', ''g'')) >= 5 THEN NULL\n'
    '              ELSE s.word END,\n'
    '         CASE WHEN s.ok THEN c.phone END, l.role,');
  d := pg_temp.p289(d, v_fn, E'l.contact_id AND c.account_id = l.account_id\n',
    E'l.contact_id AND c.account_id = l.account_id\n'
    '   CROSS JOIN LATERAL (SELECT public.memory_can_read(p_actor, p_account, ''contact'', c.id) AS ok,\n'
    '                              (regexp_match(c.name, ''\\S+''))[1] AS word) s\n');
  v_defs := v_defs || d;

  v_fn := 'desk_company_overview';
  d := pg_get_functiondef('public.desk_company_overview(uuid, uuid, uuid)'::regprocedure);
  d := pg_temp.p289(d, v_fn,
    E'FROM public.cases k WHERE k.account_id = p_account AND k.desk_customer_id = p_customer),',
    E'FROM public.cases k WHERE k.account_id = p_account AND k.desk_customer_id = p_customer\n'
    '                 AND (v_lead OR public.case_can_read(k.id, p_actor))),');
  v_defs := v_defs || d;

  -- ---------- 2. team chat ----------
  v_fn := 'chat_add_members';
  d := pg_get_functiondef('public.chat_add_members(uuid, uuid[])'::regprocedure);
  d := pg_temp.p289(d, v_fn,
    E'    IF v_my_cm <> ''admin''\n       AND EXISTS (SELECT 1 FROM unnest(v_users) u WHERE public.chat_user_role(v_ch.account_id, u) <> ''bank_guest'') THEN',
    E'    IF v_my_cm <> ''admin'' THEN');
  v_defs := v_defs || d;

  -- ---------- 5. recycle: the contacts the caller can see (contacts_select's sets) ----------
  v_fn := 'recycle_excluded_among';
  d := pg_get_functiondef('public.recycle_excluded_among(uuid[], timestamptz[])'::regprocedure);
  d := pg_temp.p289(d, v_fn, E'WHERE ct.id = x.cid AND ct.account_id = public.current_account_id())',
    E'WHERE ct.id = x.cid AND ct.account_id = public.current_account_id()\n'
    '                    AND (public.current_role_rank() >= 4  -- 289\n'
    '                         OR ct.user_id IN (SELECT public.contact_visibility_people())\n'
    '                         OR ct.id IN (SELECT public.contact_visibility_chat_contact_ids())\n'
    '                         OR ct.id IN (SELECT public.coordinator_granted_contact_ids())))');
  v_defs := v_defs || d;

  -- ---------- 6. start check (the two-argument form calls this one) ----------
  v_fn := 'team_activity_start_check';
  d := pg_get_functiondef('public.team_activity_start_check(uuid, uuid, text)'::regprocedure);
  d := pg_temp.p289(d, v_fn, E'  SELECT * INTO v_cfg FROM public.team_activity_limits(v_account);\n',
    E'  -- 289: only a chat the caller can see (team_activity_record_block''s\n'
    '  -- test, and a personal chat by its own rule); else no answer, no row.\n'
    '  IF NOT EXISTS (\n'
    '    SELECT 1 FROM public.conversations c\n'
    '    WHERE c.id = p_conversation\n'
    '      AND CASE WHEN v_personal IS NOT NULL\n'
    '               THEN public.can_view_personal_chat(c.account_id, v_personal)\n'
    '               ELSE public.can_view_conversation(c.account_id, c.user_id, c.assigned_agent_id,\n'
    '                                                 c.channel_id, c.send_channel_id)\n'
    '                    OR public.coordinator_share_grants(c.id) END\n'
    '  ) THEN\n'
    '    RETURN jsonb_build_object(''blocked'', false);\n'
    '  END IF;\n\n'
    '  SELECT * INTO v_cfg FROM public.team_activity_limits(v_account);\n');
  v_defs := v_defs || d;

  -- ---------- 7. the two insight actions ----------
  FOREACH v_fn IN ARRAY ARRAY['acknowledge_insight_attention', 'dismiss_tag_suggestion'] LOOP
    d := pg_get_functiondef(format('public.%I(uuid)', v_fn)::regprocedure);
    v_see := (regexp_match(d, 'OR (can_view_conversation\([^()]*\))'))[1];
    IF v_see IS NULL AND strpos(d, 'can_view_personal_chat') = 0 THEN
      RAISE EXCEPTION '289: % does not read as expected; nothing was changed', v_fn;
    END IF;
    IF v_see IS NOT NULL THEN
      d := pg_temp.p289(d, v_fn, 'OR ' || v_see,
        E'OR CASE WHEN v_conv.personal_owner_id IS NULL THEN ' || v_see
        || E'\n              ELSE can_view_personal_chat(v_conv.account_id, v_conv.personal_owner_id) END');
    END IF;
    v_defs := v_defs || d;
  END LOOP;

  -- ---------- 9. attachments ----------
  -- A session's upload and a forward's storage copy both carry the caller
  -- as owner; only an object the server itself wrote has none.
  v_fn := 'chat_insert_attachments';
  d := pg_get_functiondef('public.chat_insert_attachments(public.chat_channels, uuid, jsonb)'::regprocedure);
  d := pg_temp.p289(d, v_fn, E'    -- One object, one attachment row: a path already attached',
    E'    -- 289: the poster''s own upload; an object with no owner is the server''s.\n'
    '    IF EXISTS (SELECT 1 FROM storage.objects o\n'
    '                WHERE o.bucket_id = ''chat-files'' AND o.name = v_att->>''storage_path''\n'
    '                  AND coalesce(nullif(o.owner_id, ''''), o.owner::text) IS NOT NULL\n'
    '                  AND coalesce(nullif(o.owner_id, ''''), o.owner::text) IS DISTINCT FROM auth.uid()::text) THEN\n'
    '      RAISE EXCEPTION ''chat: attachment % was uploaded by someone else'', v_att->>''storage_path'' USING ERRCODE = ''42501'';\n'
    '    END IF;\n'
    '    -- One object, one attachment row: a path already attached');
  v_defs := v_defs || d;

  -- Every target was found: write.
  FOREACH d IN ARRAY v_defs LOOP
    EXECUTE d;
  END LOOP;

  -- ---------- 3. webhooks: nobody makes one in another's name ----------
  DROP POLICY IF EXISTS webhook_endpoints_insert ON public.webhook_endpoints;
  CREATE POLICY webhook_endpoints_insert ON public.webhook_endpoints FOR INSERT
    WITH CHECK (public.is_account_member(account_id, 'admin') AND created_by = (SELECT auth.uid()));
  REVOKE UPDATE ON public.webhook_endpoints FROM PUBLIC, anon, authenticated;
  GRANT UPDATE (url, events, is_active, failure_count) ON public.webhook_endpoints TO authenticated;

  -- ---------- 4. quick replies ----------
  DROP POLICY IF EXISTS quick_replies_insert ON public.quick_replies;
  CREATE POLICY quick_replies_insert ON public.quick_replies FOR INSERT
    WITH CHECK (public.is_account_member(account_id, 'agent') AND user_id = (SELECT auth.uid()));
  REVOKE UPDATE ON public.quick_replies FROM PUBLIC, anon, authenticated;
  GRANT UPDATE (title, kind, content_text, interactive_payload, updated_at) ON public.quick_replies TO authenticated;

  -- ---------- 10. the rate card: live members (NULL for a bank guest) ----------
  DROP POLICY IF EXISTS whatsapp_market_prefix_select ON public.whatsapp_market_prefix;
  CREATE POLICY whatsapp_market_prefix_select ON public.whatsapp_market_prefix FOR SELECT TO authenticated
    USING ((SELECT public.current_account_id()) IS NOT NULL);
  DROP POLICY IF EXISTS whatsapp_rate_card_select ON public.whatsapp_rate_card;
  CREATE POLICY whatsapp_rate_card_select ON public.whatsapp_rate_card FOR SELECT TO authenticated
    USING ((SELECT public.current_account_id()) IS NOT NULL);
  REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(uuid[], text, integer, integer, uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(uuid[], text, integer, integer, uuid) TO authenticated, service_role;
END
$do$;

-- ---------- 8. deal room roster ----------
CREATE OR REPLACE VIEW public.deal_room_roster WITH (security_barrier = true) AS
SELECT p.id,
       p.room_id,
       CASE
         WHEN a.access = 'guest'
              AND (NOT p.expected
                   OR (p.phone IS NOT NULL
                       AND (strpos(regexp_replace(p.display_name, '\D', '', 'g'), p.phone) > 0
                            -- 289: the number in a local form ("050 123 4567").
                            OR (char_length(p.phone) >= 7
                                AND strpos(regexp_replace(p.display_name, '\D', '', 'g'), right(p.phone, 7)) > 0))))
         THEN 'Unlisted number' || coalesce(' ending ' || right(p.phone, 2), '')
         ELSE p.display_name
       END AS display_name,
       p.role,
       p.status,
       p.joined_at,
       p.left_at
  FROM public.deal_room_participants p
 CROSS JOIN LATERAL (SELECT public.deal_room_access(p.room_id) AS access OFFSET 0) a
 WHERE a.access IS NOT NULL;

RESET lock_timeout;
