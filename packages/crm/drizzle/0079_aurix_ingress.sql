-- Aurix ingress is dormant until an operator provisions an installation.
CREATE TABLE aurix_installations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  aurix_org_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, org_id)
);
--> statement-breakpoint
CREATE TABLE aurix_keys (
  installation_id uuid NOT NULL REFERENCES aurix_installations(id) ON DELETE CASCADE,
  key_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  encrypted_secret text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retiring','revoked')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  PRIMARY KEY(installation_id, direction, key_id)
);
--> statement-breakpoint
CREATE TABLE aurix_lead_links (
  installation_id uuid NOT NULL,
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  phone text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  context jsonb NOT NULL,
  workflow_state text NOT NULL DEFAULT 'hold_for_qa' CHECK (workflow_state IN ('hold_for_qa','hold_for_consent','human_hold')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id, lead_id),
  UNIQUE(installation_id, contact_id),
  FOREIGN KEY(installation_id, org_id) REFERENCES aurix_installations(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX aurix_links_phone_idx ON aurix_lead_links(org_id, phone);
--> statement-breakpoint
CREATE TABLE aurix_inbox (
  installation_id uuid NOT NULL REFERENCES aurix_installations(id) ON DELETE RESTRICT,
  message_id text NOT NULL,
  body_hash text NOT NULL,
  raw_body text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id, message_id)
);
--> statement-breakpoint
ALTER TABLE aurix_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aurix_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE aurix_lead_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE aurix_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON aurix_installations, aurix_keys, aurix_lead_links, aurix_inbox FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION accept_aurix_lead(
  p_installation uuid, p_message text, p_hash text, p_raw text,
  p_lead uuid, p_phone text, p_first text, p_last text,
  p_updated timestamptz, p_allowed boolean
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_install public.aurix_installations%ROWTYPE;
  v_receipt public.aurix_inbox%ROWTYPE;
  v_link public.aurix_lead_links%ROWTYPE;
  v_contact uuid;
  v_response jsonb;
  v_state text;
  v_created boolean := false;
BEGIN
  -- This short transaction serializes identity, receipt and consent checks.
  -- There are no network calls under this lock.
  SELECT * INTO v_install FROM public.aurix_installations WHERE id=p_installation FOR UPDATE;
  IF NOT FOUND OR v_install.status <> 'active' THEN RAISE EXCEPTION 'installation_not_active'; END IF;
  SELECT * INTO v_receipt FROM public.aurix_inbox WHERE installation_id=p_installation AND message_id=p_message;
  IF FOUND THEN
    IF v_receipt.body_hash <> p_hash OR v_receipt.raw_body <> p_raw THEN RAISE EXCEPTION 'message_body_conflict'; END IF;
    RETURN v_receipt.response;
  END IF;
  SELECT * INTO v_link FROM public.aurix_lead_links WHERE installation_id=p_installation AND lead_id=p_lead;
  IF FOUND THEN
    v_contact := v_link.contact_id;
    IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id=v_contact AND org_id=v_install.org_id) THEN
      RAISE EXCEPTION 'contact_identity_conflict';
    END IF;
  ELSE
    -- Email is read-only integration context: native contacts have a unique
    -- email index that would otherwise merge independent Aurix lead IDs.
    INSERT INTO public.contacts(org_id, first_name, last_name, phone, source)
    VALUES(v_install.org_id, p_first, p_last, p_phone, 'aurixcrm') RETURNING id INTO v_contact;
    v_created := true;
  END IF;
  v_state := 'hold_for_qa';
  IF NOT p_allowed OR EXISTS (
    SELECT 1 FROM public.suppression_list WHERE org_id=v_install.org_id AND channel='sms' AND phone=p_phone
  ) THEN v_state := 'hold_for_consent'; END IF;
  INSERT INTO public.aurix_lead_links(installation_id, org_id, lead_id, contact_id, phone, source_updated_at, context, workflow_state)
  VALUES(p_installation, v_install.org_id, p_lead, v_contact, p_phone, p_updated, p_raw::jsonb, v_state)
  ON CONFLICT(installation_id, lead_id) DO UPDATE SET
    phone=EXCLUDED.phone, source_updated_at=EXCLUDED.source_updated_at,
    context=EXCLUDED.context, workflow_state=CASE WHEN aurix_lead_links.workflow_state='human_hold' THEN 'human_hold' ELSE EXCLUDED.workflow_state END,
    updated_at=now()
  WHERE EXCLUDED.source_updated_at >= aurix_lead_links.source_updated_at;
  IF v_created OR p_updated >= v_link.source_updated_at THEN
    UPDATE public.contacts SET first_name=p_first,last_name=p_last,phone=p_phone,updated_at=now()
    WHERE id=v_contact AND org_id=v_install.org_id;
  END IF;
  v_response := jsonb_build_object('status', CASE WHEN v_created THEN 'created' ELSE 'updated' END,
    'lead_id',p_lead,'contact_id',v_contact,'workflow_run_id',NULL,'accepted_at',now());
  INSERT INTO public.aurix_inbox(installation_id,message_id,body_hash,raw_body,response)
  VALUES(p_installation,p_message,p_hash,p_raw,v_response);
  RETURN v_response;
END;
$$;
REVOKE ALL ON FUNCTION accept_aurix_lead(uuid,text,text,text,uuid,text,text,text,timestamptz,boolean) FROM PUBLIC;
