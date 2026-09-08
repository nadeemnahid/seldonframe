-- Isolated validation only. Do not delete authoritative production identities.
BEGIN;
DROP FUNCTION accept_aurix_lead(uuid,text,text,text,uuid,text,text,text,timestamptz,boolean);
DROP TABLE aurix_inbox;
DROP TABLE aurix_lead_links;
DROP TABLE aurix_keys;
DROP TABLE aurix_installations;
COMMIT;
