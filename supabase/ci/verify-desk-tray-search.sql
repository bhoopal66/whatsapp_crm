-- Migration 329: search the desk tray by the customer's name or number.
-- Everything is rolled back; run as a superuser. A failed check raises.
BEGIN;
DO $verify$
DECLARE
  u_owner uuid := '00000000-0000-4000-8000-000000329001';
  u_hold  uuid := '00000000-0000-4000-8000-000000329002';  -- agent holding RAK
  at0 timestamptz := '2026-11-28 08:00:00+00';
  acct uuid; c_ar uuid; c_en uuid; c_hid uuid; t_ar uuid; t_en uuid; t_hid uuid;
  base jsonb; j jsonb;
BEGIN
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dts329_tray(p_acct uuid, p_contact uuid, p_bank text) RETURNS uuid
    LANGUAGE plpgsql AS $b$
    DECLARE cv uuid; msg uuid; doc uuid; tr uuid; u text := 'https://x.invalid/dts329-' || gen_random_uuid() || '.pdf';
    BEGIN
      INSERT INTO conversations (account_id, user_id, contact_id)
      SELECT p_acct, user_id, id FROM contacts WHERE id = p_contact RETURNING id INTO cv;
      INSERT INTO messages (conversation_id, sender_type, content_type, media_url)
      VALUES (cv, 'customer', 'document', u) RETURNING id INTO msg;
      PERFORM customer_documents_record(p_acct, p_contact, 'chat', 'document', u, now(), cv, msg, NULL,
                                        'application/pdf', 'dts329.pdf', NULL);
      SELECT id INTO doc FROM customer_documents WHERE message_id = msg;
      INSERT INTO desk_tray (account_id, customer_document_id, contact_id, conversation_id, reason, candidates,
                             received_at)
      VALUES (p_acct, doc, p_contact, cv, 'many_cases',
              jsonb_build_array(jsonb_build_object('case_id', gen_random_uuid(), 'bank_code', p_bank,
                                                   'company', 'dts329 co', 'why', '[]'::jsonb)),
              '2026-11-28 07:00:00+00')
      RETURNING id INTO tr;
      RETURN tr;
    END $b$ $fn$;
  -- The tray ids of a page, sorted.
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dts329_ids(p jsonb) RETURNS uuid[] LANGUAGE sql AS $b$
      SELECT coalesce(array_agg((e->>'tray_id')::uuid ORDER BY e->>'tray_id'), '{}')
        FROM jsonb_array_elements(p->'items') e
    $b$ $fn$;
  EXECUTE $fn$
    CREATE FUNCTION pg_temp.dts329_set(VARIADIC p uuid[]) RETURNS uuid[] LANGUAGE sql AS $b$
      SELECT coalesce(array_agg(x ORDER BY x::text), '{}') FROM unnest(p) x
    $b$ $fn$;

  INSERT INTO auth.users (id, email) VALUES (u_owner, 'dts329-owner@example.invalid'),
    (u_hold, 'dts329-hold@example.invalid');
  SELECT account_id INTO acct FROM profiles WHERE user_id = u_owner;
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id = u_hold;
  INSERT INTO case_banks (account_id, code, name) VALUES (acct, 'RAK', 'RAK'), (acct, 'ENBD', 'ENBD')
  ON CONFLICT DO NOTHING;
  INSERT INTO coordinator_banks (account_id, user_id, bank_code) VALUES (acct, u_hold, 'RAK');
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (acct, u_owner, '971501110001', 'أحمد المنصوري') RETURNING id INTO c_ar;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (acct, u_owner, '971501110002', 'dts329 Zayed 50% off_x') RETURNING id INTO c_en;
  INSERT INTO contacts (account_id, user_id, phone, name)
  VALUES (acct, u_owner, '971509990003', 'dts329 zayed hidden') RETURNING id INTO c_hid;
  t_ar := pg_temp.dts329_tray(acct, c_ar, 'RAK');
  t_en := pg_temp.dts329_tray(acct, c_en, 'RAK');
  t_hid := pg_temp.dts329_tray(acct, c_hid, 'ENBD');  -- not at the holder's bank

  -- No search: exactly 303's answer, whether p_q is missing, NULL, empty or blank.
  base := desk_tray_page(u_owner, acct, 'open', 100, at0);
  ASSERT (base->>'total')::int = 3 AND pg_temp.dts329_ids(base) = pg_temp.dts329_set(t_ar, t_en, t_hid),
    'owner baseline ' || base::text;
  ASSERT desk_tray_page(u_owner, acct, 'open', 100, at0, NULL) = base, 'NULL p_q';
  ASSERT desk_tray_page(u_owner, acct, 'open', 100, at0, '') = base, 'empty p_q';
  ASSERT desk_tray_page(u_owner, acct, 'open', 100, at0, E'  \t ') = base, 'blank p_q';
  ASSERT desk_tray_page(u_hold, acct, 'open', 100, at0, '  ') = desk_tray_page(u_hold, acct, 'open', 100, at0),
    'blank p_q, holder';
  ASSERT pg_temp.dts329_ids(desk_tray_page(u_hold, acct, 'open', 100, at0)) = pg_temp.dts329_set(t_ar, t_en),
    'holder baseline';
  -- Positional calls from before 329 still resolve.
  j := desk_tray_page(u_owner, acct, 'open', 1);
  ASSERT (j->>'total')::int = 3 AND jsonb_array_length(j->'items') = 1, 'positional, limit 1';

  -- By name: Arabic as typed, part of a name, any case.
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, 'أحمد');
  ASSERT pg_temp.dts329_ids(j) = ARRAY[t_ar] AND (j->>'total')::int = 1, 'arabic name ' || j::text;
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, ' المنصوري ');
  ASSERT pg_temp.dts329_ids(j) = ARRAY[t_ar], 'arabic surname';
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, 'ZAYED');
  ASSERT pg_temp.dts329_ids(j) = pg_temp.dts329_set(t_en, t_hid) AND (j->>'total')::int = 2, 'any case';

  -- By number: spaces and '+' ignored on both sides.
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, '+971 50 111');
  ASSERT pg_temp.dts329_ids(j) = pg_temp.dts329_set(t_ar, t_en), 'phone with plus and spaces ' || j::text;
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, '(050) 999-0003');
  ASSERT pg_temp.dts329_ids(j) = '{}', 'a leading 0 is a digit like any other';
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, '999 0003');
  ASSERT pg_temp.dts329_ids(j) = ARRAY[t_hid], 'phone tail';
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, 'zayed 0001');
  ASSERT pg_temp.dts329_ids(j) = '{}', 'a name with digits is not a phone search';

  -- Never wider than the caller's tray.
  j := desk_tray_page(u_hold, acct, 'open', 100, at0, 'zayed');
  ASSERT pg_temp.dts329_ids(j) = ARRAY[t_en] AND (j->>'total')::int = 1, 'holder by name ' || j::text;
  j := desk_tray_page(u_hold, acct, 'open', 100, at0, '+971 50999');
  ASSERT pg_temp.dts329_ids(j) = '{}' AND (j->>'total')::int = 0, 'holder by number';

  -- The person's text is literal.
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, '%');
  ASSERT pg_temp.dts329_ids(j) = ARRAY[t_en], 'percent is literal ' || j::text;
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, '_');
  ASSERT pg_temp.dts329_ids(j) = ARRAY[t_en], 'underscore is literal';
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, '\');
  ASSERT pg_temp.dts329_ids(j) = '{}', 'backslash is literal';
  j := desk_tray_page(u_owner, acct, 'open', 100, at0, 'Zayed%hidden');
  ASSERT pg_temp.dts329_ids(j) = '{}', 'percent is not a wildcard';

  -- Paging is 303's over the matches.
  j := desk_tray_page(u_owner, acct, 'open', 1, at0, 'zayed');
  ASSERT (j->>'total')::int = 2 AND jsonb_array_length(j->'items') = 1, 'limit over matches';

  RAISE NOTICE 'verify-desk-tray-search: ok';
END
$verify$;
ROLLBACK;
