-- 158: team chat sensitive-data guard (087 family). A workspace can block
-- team-chat messages that carry an Emirates ID, a payment card number or
-- an IBAN, in channels with a bank guest or everywhere.
--
--   A. chat_sensitive_kinds(body): the sorted distinct subset of
--      {card, emirates_id, iban} in a text. It mirrors
--      containsSensitiveData (src/lib/kb/sensitive.ts) and the patterns
--      it imports from src/lib/typesafe/redact.ts: change one, change
--      both. Digits are folded to ASCII (NFKC, then every Unicode decimal
--      digit, the Arabic thousands / decimal separators); an Emirates ID
--      by redact's EID pattern; an IBAN only checksum-valid (mod 97), of
--      a listed country, at its exact length, with at least 10 BBAN
--      digits; a card only once phone numbers are replaced by ' # ', as
--      a 13..19-digit run that passes Luhn. JS \s and \d are spelled out
--      (Postgres classes are locale-dependent), and no flag is used.
--      kinds <> '{}' agrees with containsSensitiveData exactly. Only the
--      labels go beyond it: a card match that is really the Emirates ID
--      or IBAN already found (an Emirates ID passes Luhn) is re-checked
--      with those spans blanked, so the label does not say 'card' for
--      an ID; the text is sensitive either way.
--   B. chat_workspace_settings.sensitive_mode ('off' | 'warn' | 'block',
--      default off) and sensitive_scope ('guests' | 'all', default
--      guests). Written by chat_set_sensitive_guard (live owner / admin,
--      audited 'update_sensitive_guard'); chat_my_permissions shows it.
--   C. Enforcement is a BEFORE INSERT OR UPDATE OF body trigger on
--      internal_messages, so posts, forwards and edits are all covered
--      without redefining a chat function. It acts on a person's live
--      message only (not system posts, deletes or erasures) and only in
--      'block'. Scope 'guests' means a channel other than a deal room
--      (its Team notes are staff-only) with a bank guest member, by the
--      test 102 uses before sharing a customer card. The refusal is 42501
--      with 'contains sensitive data' in its message. 'warn' is the
--      client's business. Attachment contents are not scanned.
--
-- Must be applied by a superuser or BYPASSRLS role, like 087 and 157:
-- the SECURITY DEFINER functions read and write RLS-forced tables with
-- no write policy. Re-runnable; no BEGIN/COMMIT. Nothing is granted to
-- service_role (verify-internal-chat-admin.sql pins that list).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '158 must be applied by a superuser or BYPASSRLS role (the chat functions own RLS-forced tables)';
  END IF;
END $$;

-- ---------- Audit action ----------

ALTER TABLE public.chat_audit_log DROP CONSTRAINT IF EXISTS chat_audit_log_action_check;
ALTER TABLE public.chat_audit_log ADD CONSTRAINT chat_audit_log_action_check CHECK (action IN (
  'admin_read_private','erase_person','add_members','set_member_role',
  'update_channel','archive_channel','unarchive_channel','remove_member',
  'set_permissions','update_settings','update_policy','update_sensitive_guard'));

-- ---------- B. Settings ----------

ALTER TABLE public.chat_workspace_settings ADD COLUMN IF NOT EXISTS sensitive_mode text NOT NULL DEFAULT 'off'
  CONSTRAINT chat_workspace_settings_sensitive_mode_check CHECK (sensitive_mode IN ('off','warn','block'));
ALTER TABLE public.chat_workspace_settings ADD COLUMN IF NOT EXISTS sensitive_scope text NOT NULL DEFAULT 'guests'
  CONSTRAINT chat_workspace_settings_sensitive_scope_check CHECK (sensitive_scope IN ('guests','all'));

-- ---------- A. Detector ----------

CREATE OR REPLACE FUNCTION public.chat_sensitive_kinds(p_body text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  -- JS \s (WhiteSpace + LineTerminator), as bracket-expression content.
  ws text := chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || ' ' || chr(160) || chr(5760)
             || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287)
             || chr(12288) || chr(65279);
  -- The zero of every run of ten Unicode decimal digits above U+007F
  -- (\p{Nd}, Unicode 17); a digit's value is its distance from its zero.
  zeros int[] := ARRAY[1632,1776,1984,2406,2534,2662,2790,2918,3046,3174,3302,3430,3558,3664,3792,
    3872,4160,4240,6112,6160,6470,6608,6784,6800,6992,7088,7232,7248,42528,43216,43264,43472,43504,
    43600,44016,65296,66720,68912,68928,69734,69872,69942,70096,70384,70736,70864,71248,71360,71376,
    71386,71472,71904,72016,72688,72784,73040,73120,73184,73552,90416,92768,92864,93008,93552,
    118000,120782,120792,120802,120812,120822,123200,123632,124144,124401,125264,130032];
  iban_lengths jsonb := '{"AE":23,"SA":24,"QA":29,"KW":30,"BH":22,"OM":23,"IQ":23,"JO":30,"LB":28,
    "EG":29,"PK":24,"TR":26,"GB":22,"IE":22,"DE":22,"FR":27,"NL":18,"BE":16,"LU":20,"AT":20,"CH":21,
    "IT":27,"ES":24,"PT":25}';
  sep_card text;   -- [\s.\-/]
  sep_ph   text;   -- [\s.\-]
  re_eid   text;
  re_card  text;
  re_uae   text;
  re_intl  text;
  t text; s text; v_from text; v_to text; m text; d text;
  c text[]; b text[]; parts text[];
  n int; i int; e int; k int; q int; x int; v_sum int; v_rem int; v_len int; v_pass int := 1;
  dg text; v_cc text; v_cmp text; ch text;
  v_dbl boolean; v_eid boolean; v_iban boolean := false; v_card boolean;
  v_kinds text[] := '{}';
BEGIN
  IF p_body IS NULL OR p_body = '' THEN
    RETURN v_kinds;
  END IF;
  sep_card := '[' || ws || './-]';
  sep_ph   := '[' || ws || '.-]';
  re_eid   := '(?<![0-9])784' || sep_card || '*[0-9]{4}' || sep_card || '*[0-9]{7}' || sep_card
              || '*[0-9](?![0-9])';
  re_card  := '(?<![0-9])(?:[0-9]' || sep_card || '{0,3}){12,18}[0-9](?![0-9])';
  re_uae   := '(?<![0-9])(?:(?:[+]|00)?971' || sep_ph || '*(?:[(]0[)]' || sep_ph || '*)?|[(]?0)'
              || '(?:5[0-9]|[2-9])[)]?(?:' || sep_ph || '*[0-9]){7}(?![0-9])';
  re_intl  := '[+][' || ws || ']?[0-9]{1,3}' || sep_ph || '*(?:[(]?[0-9]{1,4}[)]?' || sep_ph
              || '*){1,5}[0-9]{2,4}(?![0-9])';

  -- normaliseDigits
  t := normalize(p_body, NFKC);
  IF octet_length(t) <> char_length(t) THEN
    SELECT string_agg(chr(z + dd), '' ORDER BY z, dd), string_agg(dd::text, '' ORDER BY z, dd)
      INTO v_from, v_to FROM unnest(zeros) z, generate_series(0, 9) dd;
    t := translate(t, v_from || chr(1644) || chr(1643), v_to || ',.');
  END IF;

  v_eid := t ~ re_eid;

  -- containsIban / ibanAt over the text with each whitespace run as one space.
  c := string_to_array(regexp_replace(t, '[' || ws || ']+', ' ', 'g'), NULL);
  b := c;   -- the same, with each valid IBAN blanked (for the card label only)
  n := coalesce(array_length(c, 1), 0);
  i := 1;
  WHILE i <= n LOOP
    e := 0;
    IF (i = 1 OR c[i-1] !~ '[A-Za-z0-9]') AND i + 3 <= n AND c[i] ~ '[A-Za-z]' AND c[i+1] ~ '[A-Za-z]' THEN
      IF c[i+2] IN (' ', '-') THEN
        IF i + 4 <= n AND c[i+3] ~ '[0-9]' AND c[i+4] ~ '[0-9]' THEN
          e := i + 5; dg := c[i+3] || c[i+4];
        END IF;
      ELSIF c[i+2] ~ '[0-9]' AND c[i+3] ~ '[0-9]' THEN
        e := i + 4; dg := c[i+2] || c[i+3];
      END IF;
    END IF;
    IF e = 0 THEN
      i := i + 1;
      CONTINUE;
    END IF;
    v_cc := upper(c[i] || c[i+1]);
    v_len := (iban_lengths ->> v_cc)::int;
    IF v_len IS NOT NULL THEN
      v_cmp := v_cc || dg;
      k := e;
      WHILE length(v_cmp) < v_len AND k <= n LOOP
        IF c[k] ~ '[A-Za-z0-9]' THEN
          v_cmp := v_cmp || upper(c[k]);
        ELSIF c[k] NOT IN (' ', '-') THEN
          EXIT;
        END IF;
        k := k + 1;
      END LOOP;
      IF length(v_cmp) = v_len AND NOT (k <= n AND c[k] ~ '[A-Za-z0-9]')
         AND length(regexp_replace(substr(v_cmp, 5), '[^0-9]', '', 'g')) >= 10 THEN
        v_rem := 0;
        FOREACH ch IN ARRAY string_to_array(substr(v_cmp, 5) || substr(v_cmp, 1, 4), NULL) LOOP
          x := ascii(ch);
          IF x >= 65 THEN
            v_rem := (v_rem * 100 + x - 55) % 97;
          ELSE
            v_rem := (v_rem * 10 + x - 48) % 97;
          END IF;
        END LOOP;
        IF v_rem = 1 THEN
          v_iban := true;
          FOR q IN i .. k - 1 LOOP
            b[q] := '#';
          END LOOP;
        END IF;
      END IF;
    END IF;
    i := e;
  END LOOP;

  -- Cards, after phone numbers are replaced by ' # '.
  -- A second pass, only to label: with the Emirates IDs and IBANs found
  -- blanked, so an ID that passes Luhn is not also called a card.
  s := t;
  LOOP
    s := regexp_replace(s, re_uae, ' # ', 'g');
    -- PHONE_INTL is replaced only when it has 8..15 digits: rebuild the
    -- text from the pieces between matches and each match's verdict.
    parts := regexp_split_to_array(s, re_intl);
    IF array_length(parts, 1) > 1 THEN
      d := parts[1];
      i := 1;
      FOR m IN SELECT r.x[1] FROM regexp_matches(s, re_intl, 'g') WITH ORDINALITY AS r(x, o) ORDER BY r.o LOOP
        i := i + 1;
        d := d || CASE WHEN length(regexp_replace(m, '[^0-9]', '', 'g')) BETWEEN 8 AND 15 THEN ' # ' ELSE m END
               || parts[i];
      END LOOP;
      s := d;
    END IF;

    v_card := false;
    FOR m IN SELECT r.x[1] FROM regexp_matches(s, re_card, 'g') AS r(x) LOOP
      d := regexp_replace(m, '[^0-9]', '', 'g');
      IF length(d) BETWEEN 13 AND 19 THEN
        v_sum := 0;
        v_dbl := false;
        FOR q IN REVERSE length(d) .. 1 LOOP
          x := ascii(substr(d, q, 1)) - 48;
          IF v_dbl THEN
            x := x * 2;
            IF x > 9 THEN x := x - 9; END IF;
          END IF;
          v_sum := v_sum + x;
          v_dbl := NOT v_dbl;
        END LOOP;
        IF v_sum % 10 = 0 THEN
          v_card := true;
          EXIT;
        END IF;
      END IF;
    END LOOP;

    EXIT WHEN v_pass = 2 OR NOT v_card OR NOT (v_eid OR v_iban);
    v_pass := 2;
    s := regexp_replace(array_to_string(b, ''), re_eid, ' # ', 'g');
  END LOOP;

  IF v_card THEN v_kinds := v_kinds || 'card'::text; END IF;
  IF v_eid THEN v_kinds := v_kinds || 'emirates_id'::text; END IF;
  IF v_iban THEN v_kinds := v_kinds || 'iban'::text; END IF;
  RETURN v_kinds;
END $$;

-- ---------- C. Setter ----------

CREATE OR REPLACE FUNCTION public.chat_set_sensitive_guard(p_ws uuid, p_mode text, p_scope text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.chat_workspace_settings;
BEGIN
  IF v_uid IS NULL OR coalesce(public.chat_ws_role(p_ws), '') NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'chat_set_sensitive_guard: owner or admin role required' USING ERRCODE = '42501';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('off','warn','block') OR p_scope IS NULL OR p_scope NOT IN ('guests','all') THEN
    RAISE EXCEPTION 'chat_set_sensitive_guard: mode is off, warn or block; scope is guests or all'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.chat_workspace_settings WHERE account_id = p_ws FOR UPDATE;
  INSERT INTO public.chat_workspace_settings AS s
         (account_id, sensitive_mode, sensitive_scope, updated_by, updated_at)
  VALUES (p_ws, p_mode, p_scope, v_uid, now())
  ON CONFLICT (account_id) DO UPDATE
     SET sensitive_mode = EXCLUDED.sensitive_mode,
         sensitive_scope = EXCLUDED.sensitive_scope,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.chat_audit_log (account_id, actor_id, action, detail)
  VALUES (p_ws, v_uid, 'update_sensitive_guard', jsonb_build_object(
    'old', jsonb_build_object('mode', coalesce(v_old.sensitive_mode, 'off'),
                              'scope', coalesce(v_old.sensitive_scope, 'guests')),
    'new', jsonb_build_object('mode', p_mode, 'scope', p_scope)));
END $$;

-- ---------- D. chat_my_permissions (157's, plus "sensitive") ----------

CREATE OR REPLACE FUNCTION public.chat_my_permissions(p_ws uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_class text := public.chat_role_class(p_ws, auth.uid());
  v_set   public.chat_workspace_settings;
BEGIN
  IF v_uid IS NULL OR v_class IS NULL THEN
    RAISE EXCEPTION 'chat_my_permissions: not a member of this workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_set FROM public.chat_workspace_settings WHERE account_id = p_ws;
  RETURN jsonb_build_object(
    'role_class', v_class,
    'capabilities', (SELECT jsonb_object_agg(c, public.chat_has_permission(p_ws, v_uid, c))
                       FROM unnest(ARRAY['create_team_channel','create_private_channel','open_group_dm',
                                         'mention_everyone','upload_files','send_voice','pin_messages',
                                         'forward_messages','share_cards','add_members','edit_own',
                                         'delete_own']) c),
    'edit_window_minutes', v_set.edit_window_minutes,
    'delete_window_minutes', v_set.delete_window_minutes,
    'windows_apply', v_class NOT IN ('owner','admin'),
    -- 158: applies to owners too; the client warns in 'warn'.
    'sensitive', jsonb_build_object('mode', coalesce(v_set.sensitive_mode, 'off'),
                                    'scope', coalesce(v_set.sensitive_scope, 'guests')));
END $$;

-- ---------- E. Enforcement ----------

CREATE OR REPLACE FUNCTION public.chat_sensitive_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_mode  text;
  v_scope text;
  v_kinds text[];
BEGIN
  IF NEW.author_kind <> 'user' OR NEW.deleted_at IS NOT NULL OR NEW.erased_at IS NOT NULL
     OR (TG_OP = 'UPDATE' AND NEW.body IS NOT DISTINCT FROM OLD.body) THEN
    RETURN NEW;
  END IF;
  SELECT s.sensitive_mode, s.sensitive_scope INTO v_mode, v_scope
    FROM public.chat_workspace_settings s WHERE s.account_id = NEW.account_id;
  IF v_mode IS DISTINCT FROM 'block' THEN
    RETURN NEW;
  END IF;
  -- 'guests': a channel with a bank guest member (102's test), never a
  -- deal room's Team notes, which guests cannot read.
  IF v_scope = 'guests' AND NOT EXISTS (
       SELECT 1 FROM public.chat_channels c
         JOIN public.chat_channel_members cm ON cm.channel_id = c.id
        WHERE c.id = NEW.channel_id AND c.kind <> 'deal_room'
          AND (cm.role = 'guest' OR public.chat_user_role(c.account_id, cm.user_id) = 'bank_guest')) THEN
    RETURN NEW;
  END IF;
  -- A mention is stored as <@uuid>; a uuid's digit groups can read as a
  -- Luhn-valid card, so mention tokens are taken out before the scan.
  v_kinds := public.chat_sensitive_kinds(regexp_replace(NEW.body,
    '<@[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}>', ' ', 'g'));
  IF v_kinds <> '{}' THEN
    RAISE EXCEPTION 'chat: this message contains sensitive data (%) and this workspace blocks it %',
      array_to_string(v_kinds, ', '),
      CASE WHEN v_scope = 'all' THEN 'in team chat' ELSE 'in channels with bank guests' END
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS internal_messages_sensitive_guard ON public.internal_messages;
CREATE TRIGGER internal_messages_sensitive_guard BEFORE INSERT OR UPDATE OF body ON public.internal_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_sensitive_guard();

REVOKE ALL ON FUNCTION public.chat_sensitive_kinds(text), public.chat_sensitive_guard(),
  public.chat_set_sensitive_guard(uuid, text, text), public.chat_my_permissions(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.chat_set_sensitive_guard(uuid, text, text), public.chat_my_permissions(uuid)
  TO authenticated;
