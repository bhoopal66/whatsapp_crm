-- 285: who reads automation runs, automation steps, flow nodes and the
-- secrets of a WhatsApp number, and who a customer note is from.
--
--   automation_logs   owners and admins (the run view is their screen).
--   automation_steps  owners and admins, as 017's successors already
--   flow_nodes        have it for writing. A step's or node's settings
--                     can hold a header or a URL with a secret in it.
--   whatsapp_config   rows as before; the access_token, verify_token and
--                     app_secret columns are not granted to a session at
--                     all. The server reads them with the service role
--                     (src/lib/whatsapp/channel-secrets.ts).
--   contact_notes     a new note is the writer's own, on a customer the
--                     writer can see; an edit only of one's own note,
--                     which stays that person's. Reading and deleting as
--                     before.
--
-- ORDER: the new build first, then this file. The old build reads the
-- token columns through the session and could not send after it. To go
-- back to that build, first:
--   GRANT SELECT ON public.whatsapp_config TO authenticated;
--   NOTIFY pgrst, 'reload schema';
-- Re-runnable. A column added to whatsapp_config later is readable by a
-- session only after its own GRANT SELECT (verify-read-rules.sql fails
-- until it is granted or named there as a secret).

SET lock_timeout = '5s';

-- ---- automation_logs, automation_steps, flow_nodes --------------
ALTER POLICY automation_logs_select ON automation_logs
  USING (is_account_member(account_id, 'admin'));

ALTER POLICY automation_steps_select ON automation_steps
  USING (EXISTS (
    SELECT 1 FROM automations a
     WHERE a.id = automation_steps.automation_id
       AND is_account_member(a.account_id, 'admin')
  ));

ALTER POLICY flow_nodes_select ON flow_nodes
  USING (EXISTS (
    SELECT 1 FROM flows f
     WHERE f.id = flow_nodes.flow_id
       AND is_account_member(f.account_id, 'admin')
  ));

-- ---- contact_notes ----------------------------------------------
-- `contacts` inside the check is read under its own policy, so "can see
-- the customer" is contacts_select itself (as in conversation_notes).
ALTER POLICY contact_notes_insert ON contact_notes
  WITH CHECK (
    user_id = auth.uid()
    AND account_id = (SELECT current_account_id())
    AND is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_notes.contact_id
         AND c.account_id = contact_notes.account_id
    )
  );

ALTER POLICY contact_notes_update ON contact_notes
  USING (
    user_id = auth.uid()
    AND account_id = (SELECT current_account_id())
    AND is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_notes.contact_id
         AND c.account_id = contact_notes.account_id
    )
  )
  WITH CHECK (
    user_id = auth.uid()
    AND account_id = (SELECT current_account_id())
    AND is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_notes.contact_id
         AND c.account_id = contact_notes.account_id
    )
  );

-- ---- whatsapp_config columns ------------------------------------
-- One statement: between the REVOKE and the GRANT no session could read
-- a number at all. Refuses (and undoes itself) if a secret is readable
-- afterwards, for instance through a grant another role made.
DO $grants$
DECLARE
  bad TEXT;
BEGIN
  REVOKE SELECT ON whatsapp_config FROM PUBLIC, anon, authenticated;
  REVOKE SELECT (access_token, verify_token, app_secret)
    ON whatsapp_config FROM PUBLIC, anon, authenticated;
  GRANT SELECT (
    id, user_id, account_id, provider, label, phone_number_id, waba_id,
    status, is_primary, is_personal, mirror_inbound_media, connected_at,
    registered_at, subscribed_apps_at, last_registration_error,
    created_at, updated_at
  ) ON whatsapp_config TO authenticated;

  SELECT string_agg(r || '.' || c, ', ') INTO bad
    FROM unnest(ARRAY['anon', 'authenticated']) r,
         unnest(ARRAY['access_token', 'verify_token', 'app_secret']) c
   WHERE has_column_privilege(r::name, 'whatsapp_config'::regclass, c, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '285: still readable by a session: %', bad;
  END IF;
END
$grants$;

RESET lock_timeout;
