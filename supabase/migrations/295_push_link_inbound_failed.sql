-- ============================================================
-- 295_push_link_inbound_failed.sql — three pushes that opened the bell
-- list instead of the screen the bell itself opens
--
-- push_bell_url had no branch for these (lib/notifications/target.ts has):
--  * inbound_message_failed (264): Settings -> WhatsApp, for those who can
--    edit settings.
--  * channel_disconnected / channel_reconnected of a personal number
--    (meta.personal): its holder's profile tab, where the QR is, any role.
--    An admin's opened the company numbers, anyone else's the bell list.
--  * work_handed_over (266): the inbox.
--
-- The function is changed by a line, not restated (as 282, 293): apply
-- after 293. Re-running 253 puts the old body back: re-run 282, 293, 295.
-- Additive for the previous build. Re-runnable.
-- verify-push-link-inbound.sql.
-- ============================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  v_fn text := pg_get_functiondef('public.push_bell_url(public.notifications)'::regprocedure);
BEGIN
  IF position('WHEN n.type = ''retention_failed'' THEN' IN v_fn) = 0 THEN
    RAISE EXCEPTION '295: push_bell_url is not as 282 and 293 left it';
  END IF;
  IF position('inbound_message_failed' IN v_fn) = 0 THEN
    EXECUTE replace(v_fn, 'WHEN n.type = ''retention_failed'' THEN',
      'WHEN n.type = ''inbound_message_failed'' THEN
      RETURN CASE WHEN v_role IN (''owner'', ''admin'') THEN ''/settings?tab=whatsapp'' ELSE ''/notifications'' END;
    WHEN n.type = ANY (ARRAY[''channel_disconnected'', ''channel_reconnected''])
         AND n.meta -> ''personal'' = ''true''::jsonb THEN
      RETURN ''/settings?tab=profile'';
    WHEN n.type = ''work_handed_over'' THEN
      RETURN ''/inbox'';
    WHEN n.type = ''retention_failed'' THEN');
  END IF;
END $$;

RESET lock_timeout;
