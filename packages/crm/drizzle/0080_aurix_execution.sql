-- Durable callback transport. All source changes and enqueue operations commit together.
ALTER TABLE aurix_installations ADD COLUMN callback_url text;
ALTER TABLE aurix_installations ADD COLUMN config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE aurix_installations ADD COLUMN qa_evidence jsonb;
ALTER TABLE aurix_lead_links ADD COLUMN workflow_run_id uuid REFERENCES workflow_runs(id) ON DELETE RESTRICT;
ALTER TABLE aurix_lead_links ADD COLUMN consent_override jsonb;
ALTER TABLE aurix_lead_links DROP CONSTRAINT aurix_lead_links_workflow_state_check;
ALTER TABLE aurix_lead_links ADD CONSTRAINT aurix_lead_links_workflow_state_check CHECK
 (workflow_state IN ('hold_for_qa','hold_for_consent','human_hold','running','completed','failed'));
CREATE UNIQUE INDEX aurix_link_run_uidx ON aurix_lead_links(workflow_run_id);
CREATE UNIQUE INDEX aurix_contact_owner_uidx ON aurix_lead_links(contact_id);
--> statement-breakpoint
CREATE TABLE aurix_callback_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 installation_id uuid NOT NULL REFERENCES aurix_installations(id) ON DELETE RESTRICT,
 lead_id uuid NOT NULL,
 event_id text NOT NULL,
 event_type text NOT NULL,
 source_key text NOT NULL,
 raw_body text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry','delivered','dead')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 last_error text,
 delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(installation_id, source_key), UNIQUE(installation_id,event_id),
 FOREIGN KEY(installation_id,lead_id) REFERENCES aurix_lead_links(installation_id,lead_id) ON DELETE RESTRICT
);
CREATE INDEX aurix_callback_due_idx ON aurix_callback_outbox(status,available_at);
ALTER TABLE aurix_callback_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON aurix_callback_outbox FROM PUBLIC;
CREATE TABLE aurix_booking_links (
 booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE RESTRICT,
 installation_id uuid NOT NULL,
 lead_id uuid NOT NULL,
 request_id text NOT NULL,
 revision integer NOT NULL DEFAULT 0,
 UNIQUE(installation_id,request_id),
 FOREIGN KEY(installation_id,lead_id) REFERENCES aurix_lead_links(installation_id,lead_id) ON DELETE RESTRICT
);
ALTER TABLE aurix_booking_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON aurix_booking_links FROM PUBLIC;
CREATE TABLE aurix_consent_receipts (
 org_id uuid NOT NULL REFERENCES organizations(id),
 receipt_id text NOT NULL,
 phone text NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,receipt_id)
);
ALTER TABLE aurix_consent_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON aurix_consent_receipts FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION enqueue_aurix_event(p_install uuid,p_lead uuid,p_source text,p_type text,p_data jsonb)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.aurix_lead_links%ROWTYPE; i public.aurix_installations%ROWTYPE;
 v_event text; v_raw text; existing public.aurix_callback_outbox%ROWTYPE;
BEGIN
 SELECT * INTO i FROM public.aurix_installations WHERE id=p_install;
 SELECT * INTO l FROM public.aurix_lead_links WHERE installation_id=p_install AND lead_id=p_lead;
 IF NOT FOUND THEN RAISE EXCEPTION 'aurix_identity_conflict'; END IF;
 IF p_type NOT IN ('qualification.started','qualification.completed','qualification.disqualified',
 'booking.created','booking.rescheduled','booking.cancelled','booking.completed','booking.no_show',
 'sms.opt_out','sms.opt_in','handoff.requested','call.missed','workflow.failed') THEN
 RAISE EXCEPTION 'aurix_event_type_invalid'; END IF;
 SELECT * INTO existing FROM public.aurix_callback_outbox WHERE installation_id=p_install AND source_key=p_source;
 IF FOUND THEN
  IF existing.event_type<>p_type OR existing.raw_body::jsonb->'data' IS DISTINCT FROM p_data THEN
   RAISE EXCEPTION 'aurix_event_body_conflict';
  END IF;
  RETURN existing.event_id;
 END IF;
 v_event := gen_random_uuid()::text;
 v_raw := jsonb_build_object('schema_version','1.0','event_id',v_event,'event_type',p_type,
 'occurred_at',now(),'installation_id',i.id,'organization_id',i.aurix_org_id,'workspace_id',i.org_id,
 'lead_id',l.lead_id,'contact_id',l.contact_id,'correlation_id',l.workflow_run_id,'data',p_data)::text;
 INSERT INTO public.aurix_callback_outbox(installation_id,lead_id,event_id,event_type,source_key,raw_body)
 VALUES(p_install,p_lead,v_event,p_type,p_source,v_raw);
 RETURN v_event;
END; $$;
REVOKE ALL ON FUNCTION enqueue_aurix_event(uuid,uuid,text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- A queue row's identity and signed bytes are immutable after insertion.
CREATE FUNCTION protect_aurix_callback() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.installation_id,NEW.lead_id,NEW.event_id,NEW.event_type,NEW.source_key,NEW.raw_body)
 IS DISTINCT FROM (OLD.installation_id,OLD.lead_id,OLD.event_id,OLD.event_type,OLD.source_key,OLD.raw_body)
 THEN RAISE EXCEPTION 'aurix_callback_immutable'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_callback_immutable BEFORE UPDATE ON aurix_callback_outbox FOR EACH ROW EXECUTE FUNCTION protect_aurix_callback();
--> statement-breakpoint
-- STOP is workspace+phone wide. Every exact linked lead receives the notification;
-- this fan-out records a phone preference, never merges cross-system identities.
CREATE FUNCTION aurix_suppression_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.aurix_lead_links%ROWTYPE;
BEGIN
 IF NEW.channel <> 'sms' THEN RETURN NEW; END IF;
 FOR l IN SELECT * FROM public.aurix_lead_links WHERE org_id=NEW.org_id AND phone=NEW.phone ORDER BY installation_id LOOP
  UPDATE public.aurix_lead_links SET workflow_state='hold_for_consent',consent_override=NULL,updated_at=now()
  WHERE installation_id=l.installation_id AND lead_id=l.lead_id;
  UPDATE public.workflow_runs SET status='cancelled',updated_at=now() WHERE id=l.workflow_run_id AND status IN ('running','waiting');
  PERFORM public.enqueue_aurix_event(l.installation_id,l.lead_id,'stop:'||NEW.id,'sms.opt_out',
   jsonb_build_object('phone',NEW.phone,'reason',NEW.reason));
 END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_suppression_insert AFTER INSERT ON suppression_list FOR EACH ROW EXECUTE FUNCTION aurix_suppression_changed();
--> statement-breakpoint
CREATE FUNCTION aurix_explicit_opt_in(p_org uuid,p_receipt text,p_phone text,p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.aurix_lead_links%ROWTYPE; r public.aurix_consent_receipts%ROWTYPE; captured timestamptz;
BEGIN
 -- Same advisory lock is used by the STOP route, preventing interleaved preferences.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text||p_phone,0));
 SELECT * INTO r FROM public.aurix_consent_receipts WHERE org_id=p_org AND receipt_id=p_receipt;
 IF FOUND THEN
  IF r.phone<>p_phone OR r.evidence<>p_evidence THEN RAISE EXCEPTION 'aurix_consent_conflict'; END IF;
  RETURN; -- A replay after a later STOP cannot restore consent.
 END IF;
 captured := (p_evidence->>'captured_at')::timestamptz;
 IF p_evidence->>'status' IS DISTINCT FROM 'allowed' OR length(trim(coalesce(p_evidence->>'source','')))=0
 OR p_evidence->>'explicit' IS DISTINCT FROM 'true' OR captured IS NULL OR captured>now()
 OR captured<now()-interval '5 minutes' THEN RAISE EXCEPTION 'aurix_consent_invalid'; END IF;
 IF EXISTS(SELECT 1 FROM public.suppression_list WHERE org_id=p_org AND phone=p_phone AND created_at>=captured)
 THEN RAISE EXCEPTION 'aurix_consent_stale'; END IF;
 INSERT INTO public.aurix_consent_receipts(org_id,receipt_id,phone,evidence) VALUES(p_org,p_receipt,p_phone,p_evidence);
 PERFORM set_config('aurix.optin_receipt',p_org::text||':'||p_phone,true);
 DELETE FROM public.suppression_list WHERE org_id=p_org AND channel='sms' AND phone=p_phone;
 FOR l IN SELECT * FROM public.aurix_lead_links WHERE org_id=p_org AND phone=p_phone ORDER BY installation_id LOOP
  UPDATE public.aurix_lead_links SET consent_override=p_evidence,
   workflow_state=CASE WHEN workflow_state='human_hold' THEN 'human_hold' ELSE 'hold_for_qa' END,updated_at=now()
  WHERE installation_id=l.installation_id AND lead_id=l.lead_id;
  PERFORM public.enqueue_aurix_event(l.installation_id,l.lead_id,'optin:'||p_receipt,'sms.opt_in',
   jsonb_build_object('phone',p_phone,'consent',p_evidence));
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION aurix_explicit_opt_in(uuid,text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION aurix_booking_changed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.aurix_lead_links%ROWTYPE; b public.aurix_booking_links%ROWTYPE;
 kind text; state text; request text; tz text; created boolean:=false;
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.aurix_booking_links WHERE booking_id=OLD.id)
 AND (NEW.contact_id,NEW.org_id) IS DISTINCT FROM (OLD.contact_id,OLD.org_id)
 THEN RAISE EXCEPTION 'aurix_booking_identity_conflict'; END IF;
 SELECT * INTO l FROM public.aurix_lead_links WHERE contact_id=NEW.contact_id AND org_id=NEW.org_id;
 IF NOT FOUND OR NEW.status IN ('template','pending_payment') THEN RETURN NEW; END IF;
 IF NEW.status NOT IN ('scheduled','rescheduled','cancelled','completed','no_show') THEN RAISE EXCEPTION 'aurix_booking_status_invalid'; END IF;
 SELECT * INTO b FROM public.aurix_booking_links WHERE booking_id=NEW.id FOR UPDATE;
 IF NOT FOUND THEN
  IF NEW.status NOT IN ('scheduled','rescheduled') THEN RETURN NEW; END IF;
  request:=coalesce(NEW.metadata->>'aurix_booking_request_id',NEW.id::text);
  INSERT INTO public.aurix_booking_links(booking_id,installation_id,lead_id,request_id)
   VALUES(NEW.id,l.installation_id,l.lead_id,request) RETURNING * INTO b;
  kind:='booking.created'; state:='scheduled'; created:=true;
 ELSE
  IF NEW.metadata->>'aurix_booking_request_id' IS NOT NULL AND NEW.metadata->>'aurix_booking_request_id'<>b.request_id
  THEN RAISE EXCEPTION 'aurix_booking_request_conflict'; END IF;
  IF TG_OP='UPDATE' AND (NEW.starts_at,NEW.ends_at,NEW.status) IS NOT DISTINCT FROM (OLD.starts_at,OLD.ends_at,OLD.status) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status IN ('cancelled','completed','no_show') THEN RAISE EXCEPTION 'aurix_booking_terminal'; END IF;
  state:=CASE WHEN NEW.status IN ('scheduled','rescheduled') THEN 'rescheduled' ELSE NEW.status END;
  kind:='booking.'||state;
  UPDATE public.aurix_booking_links SET revision=revision+1 WHERE booking_id=NEW.id RETURNING * INTO b;
 END IF;
 IF NEW.ends_at<=NEW.starts_at THEN RAISE EXCEPTION 'aurix_booking_time_invalid'; END IF;
 -- Only a configured real Seldon booking template may be used; no guessed timezone.
 SELECT config->>'timezone' INTO tz FROM public.aurix_installations WHERE id=l.installation_id;
 IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz) THEN RAISE EXCEPTION 'aurix_timezone_required'; END IF;
 PERFORM public.enqueue_aurix_event(l.installation_id,l.lead_id,'booking:'||NEW.id||':'||b.revision,kind,
 jsonb_build_object('booking_id',NEW.id,'booking_request_id',b.request_id,'appointment_type','roof_inspection',
 'status',state,'starts_at',NEW.starts_at,'ends_at',NEW.ends_at,'timezone',tz,'provider_event_id',NEW.external_event_id));
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_booking_lifecycle AFTER INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION aurix_booking_changed();
--> statement-breakpoint
-- Preserve live/terminal workflow state across routine lead synchronization.
CREATE FUNCTION aurix_preserve_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.workflow_run_id IS NOT NULL AND NEW.workflow_state='hold_for_qa' AND OLD.workflow_state IN ('running','completed','failed')
 THEN NEW.workflow_state:=OLD.workflow_state; END IF;
 IF NEW.phone<>OLD.phone AND OLD.workflow_run_id IS NOT NULL THEN
  NEW.workflow_state:='human_hold';
  UPDATE public.workflow_runs SET status='cancelled',updated_at=now() WHERE id=OLD.workflow_run_id AND status IN ('running','waiting');
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_preserve_workflow BEFORE UPDATE ON aurix_lead_links FOR EACH ROW EXECUTE FUNCTION aurix_preserve_run();
--> statement-breakpoint
ALTER TABLE aurix_callback_outbox ADD COLUMN acknowledged_result jsonb;
CREATE FUNCTION start_aurix_workflow(p_install uuid,p_lead uuid,p_spec jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE i public.aurix_installations%ROWTYPE;l public.aurix_lead_links%ROWTYPE; r uuid;
BEGIN
 SELECT * INTO i FROM public.aurix_installations WHERE id=p_install FOR UPDATE;
 SELECT * INTO l FROM public.aurix_lead_links WHERE installation_id=p_install AND lead_id=p_lead FOR UPDATE;
 IF NOT FOUND OR i.status<>'active' OR i.config->>'execution_enabled' IS DISTINCT FROM 'true'
 OR l.workflow_state<>'hold_for_qa' OR l.workflow_run_id IS NOT NULL THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.suppression_list WHERE org_id=l.org_id AND phone=l.phone AND channel='sms')
 OR (l.context#>>'{lead,consent,sms_status}' IS DISTINCT FROM 'allowed' AND l.consent_override IS NULL)
 THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.aurix_lead_links WHERE org_id=l.org_id AND phone=l.phone)<>1 THEN
  UPDATE public.aurix_lead_links SET workflow_state='human_hold' WHERE installation_id=p_install AND lead_id=p_lead;
  PERFORM public.enqueue_aurix_event(p_install,p_lead,'identity-hold','handoff.requested','{"reason":"ambiguous_phone_identity"}');
  RETURN NULL;
 END IF;
 r:=gen_random_uuid();
 INSERT INTO public.workflow_runs(id,org_id,archetype_id,spec_snapshot,trigger_payload,current_step_id,variable_scope)
 VALUES(r,l.org_id,'aurix-roofing-v1',p_spec,jsonb_build_object('contactId',l.contact_id,'installationId',i.id,'leadId',l.lead_id),
 'qualify','{"maxTurns":"12"}');
 UPDATE public.aurix_lead_links SET workflow_run_id=r,workflow_state='running',updated_at=now()
 WHERE installation_id=p_install AND lead_id=p_lead;
 PERFORM public.enqueue_aurix_event(p_install,p_lead,'started:'||r,'qualification.started',jsonb_build_object('workflow_run_id',r));
 RETURN r;
END; $$;
REVOKE ALL ON FUNCTION start_aurix_workflow(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION finish_aurix_qualification(p_run uuid,p_data jsonb,p_handoff boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.aurix_lead_links%ROWTYPE; kind text;
BEGIN
 SELECT * INTO l FROM public.aurix_lead_links WHERE workflow_run_id=p_run FOR UPDATE;
 IF NOT FOUND OR l.workflow_state NOT IN ('running','completed','human_hold') THEN RAISE EXCEPTION 'aurix_workflow_identity_conflict'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.aurix_installations WHERE id=l.installation_id AND status='active' AND config->>'execution_enabled'='true') THEN RAISE EXCEPTION 'aurix_execution_paused'; END IF;
 IF p_handoff THEN
  kind:='handoff.requested'; p_data:=jsonb_build_object('reason','Human review required: incomplete, uncertain or escalated qualification.');
 ELSE
  kind:=CASE WHEN p_data->>'status'='qualified' THEN 'qualification.completed' ELSE 'qualification.disqualified' END;
 END IF;
 PERFORM public.enqueue_aurix_event(l.installation_id,l.lead_id,'qualification:'||p_run,kind,p_data);
 UPDATE public.aurix_lead_links SET workflow_state=CASE WHEN p_handoff THEN 'human_hold' ELSE 'completed' END,updated_at=now()
 WHERE installation_id=l.installation_id AND lead_id=l.lead_id AND workflow_state IN ('running','completed','human_hold');
END; $$;
REVOKE ALL ON FUNCTION finish_aurix_qualification(uuid,jsonb,boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION aurix_workflow_failure() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE l public.aurix_lead_links%ROWTYPE;
BEGIN
 IF NEW.status='failed' AND OLD.status IS DISTINCT FROM NEW.status THEN
  SELECT * INTO l FROM public.aurix_lead_links WHERE workflow_run_id=NEW.id;
  IF FOUND THEN
   UPDATE public.aurix_lead_links SET workflow_state='human_hold',updated_at=now() WHERE workflow_run_id=NEW.id;
   PERFORM public.enqueue_aurix_event(l.installation_id,l.lead_id,'failed:'||NEW.id,'workflow.failed',
    jsonb_build_object('message','Roofing workflow failed; inspect the Seldon workflow run.','workflow_run_id',NEW.id));
   PERFORM public.enqueue_aurix_event(l.installation_id,l.lead_id,'failed-hold:'||NEW.id,'handoff.requested',
    '{"reason":"Workflow execution failed or became uncertain; operator review required."}');
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_workflow_failure AFTER UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION aurix_workflow_failure();
--> statement-breakpoint
CREATE FUNCTION aurix_lock_preference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.channel='sms' AND EXISTS(SELECT 1 FROM public.aurix_lead_links WHERE org_id=OLD.org_id AND phone=OLD.phone)
  AND current_setting('aurix.optin_receipt',true) IS DISTINCT FROM OLD.org_id::text||':'||OLD.phone
  THEN RAISE EXCEPTION 'aurix_explicit_consent_required'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.channel='sms' THEN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text||NEW.phone,0)); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_preference_lock BEFORE INSERT OR DELETE ON suppression_list FOR EACH ROW EXECUTE FUNCTION aurix_lock_preference();
--> statement-breakpoint
CREATE UNIQUE INDEX aurix_sms_receipt_uidx ON sms_messages(org_id,provider,external_message_id)
WHERE direction='inbound' AND metadata ? 'aurix';
--> statement-breakpoint
CREATE FUNCTION book_aurix_confirmed(p_install uuid,p_lead uuid,p_request text,p_template uuid,p_start timestamptz)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE i public.aurix_installations%ROWTYPE;l public.aurix_lead_links%ROWTYPE;t public.bookings%ROWTYPE;
 b public.aurix_booking_links%ROWTYPE; r uuid; duration integer;
BEGIN
 SELECT * INTO i FROM public.aurix_installations WHERE id=p_install FOR UPDATE;
 SELECT * INTO l FROM public.aurix_lead_links WHERE installation_id=p_install AND lead_id=p_lead FOR UPDATE;
 IF NOT FOUND OR i.status<>'active' OR i.config->>'execution_enabled' IS DISTINCT FROM 'true' OR l.workflow_state<>'completed'
 THEN RAISE EXCEPTION 'aurix_booking_not_allowed'; END IF;
 IF EXISTS(SELECT 1 FROM public.suppression_list WHERE org_id=l.org_id AND phone=l.phone AND channel='sms') THEN RAISE EXCEPTION 'aurix_sms_suppressed'; END IF;
 SELECT * INTO b FROM public.aurix_booking_links WHERE installation_id=p_install AND request_id=p_request;
 IF FOUND THEN
  IF b.lead_id<>p_lead THEN RAISE EXCEPTION 'aurix_booking_identity_conflict'; END IF;
  RETURN b.booking_id;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.aurix_callback_outbox WHERE installation_id=p_install AND lead_id=p_lead
 AND source_key='qualification:'||l.workflow_run_id AND status='delivered' AND acknowledged_result->>'canonical_qualified'='true')
 THEN RAISE EXCEPTION 'aurix_canonical_qualification_required'; END IF;
 SELECT * INTO t FROM public.bookings WHERE id=p_template AND org_id=i.org_id AND status='template' FOR UPDATE;
 IF NOT FOUND OR i.config->>'appointment_type_id' IS DISTINCT FROM p_template::text THEN RAISE EXCEPTION 'aurix_calendar_required'; END IF;
 duration := (t.metadata->>'durationMinutes')::integer;
 IF duration IS NULL OR duration<5 OR duration>480 OR p_start<=now() THEN RAISE EXCEPTION 'aurix_booking_time_invalid'; END IF;
 r:=gen_random_uuid();
 INSERT INTO public.bookings(id,org_id,contact_id,title,booking_slug,status,starts_at,ends_at,provider,metadata)
 VALUES(r,i.org_id,l.contact_id,t.title,t.booking_slug,'scheduled',p_start,p_start+duration*interval '1 minute','manual',
 jsonb_build_object('source','aurix-roofing-v1','appointmentTypeId',p_template,'aurix_booking_request_id',p_request));
 RETURN r;
END; $$;
REVOKE ALL ON FUNCTION book_aurix_confirmed(uuid,uuid,text,uuid,timestamptz) FROM PUBLIC;
--> statement-breakpoint
-- Serialize all writes to an Aurix-managed Seldon calendar, including native UI
-- writes, so availability checks cannot race two local reservations into one slot.
CREATE FUNCTION aurix_calendar_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status NOT IN ('scheduled','rescheduled','pending_payment') THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.aurix_installations i JOIN public.bookings t ON t.id::text=i.config->>'appointment_type_id'
 WHERE i.org_id=NEW.org_id AND t.booking_slug=NEW.booking_slug) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text||NEW.booking_slug,1));
  IF EXISTS(SELECT 1 FROM public.bookings b WHERE b.org_id=NEW.org_id AND b.booking_slug=NEW.booking_slug AND b.id<>NEW.id
   AND b.status IN ('scheduled','rescheduled','pending_payment') AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at)
  THEN RAISE EXCEPTION 'aurix_calendar_slot_conflict'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_calendar_guard BEFORE INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION aurix_calendar_guard();
--> statement-breakpoint
ALTER TABLE aurix_lead_links ADD COLUMN execution_lease_until timestamptz;
CREATE FUNCTION start_aurix_voice(p_install uuid,p_lead uuid,p_call text) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE i public.aurix_installations%ROWTYPE;l public.aurix_lead_links%ROWTYPE;r uuid;
BEGIN
 SELECT * INTO i FROM public.aurix_installations WHERE id=p_install FOR UPDATE;
 SELECT * INTO l FROM public.aurix_lead_links WHERE installation_id=p_install AND lead_id=p_lead FOR UPDATE;
 IF NOT FOUND OR i.status<>'active' OR i.config->>'execution_enabled' IS DISTINCT FROM 'true'
 OR l.workflow_state NOT IN ('hold_for_qa','running') THEN RETURN NULL; END IF;
 IF l.workflow_run_id IS NOT NULL THEN
  SELECT id INTO r FROM public.workflow_runs WHERE id=l.workflow_run_id AND trigger_payload->>'callId'=p_call AND status='waiting';
  RETURN r;
 END IF;
 IF (SELECT count(*) FROM public.aurix_lead_links WHERE org_id=l.org_id AND phone=l.phone)<>1 THEN RETURN NULL; END IF;
 r:=gen_random_uuid();
 INSERT INTO public.workflow_runs(id,org_id,archetype_id,spec_snapshot,trigger_payload,current_step_id,variable_scope,status)
 VALUES(r,l.org_id,'aurix-roofing-voice-v1','{"name":"Aurix roofing voice","steps":[]}',
 jsonb_build_object('contactId',l.contact_id,'callId',p_call),'voice-evidence','{}','waiting');
 UPDATE public.aurix_lead_links SET workflow_run_id=r,workflow_state='running',updated_at=now() WHERE installation_id=p_install AND lead_id=p_lead;
 PERFORM public.enqueue_aurix_event(p_install,p_lead,'started:'||r,'qualification.started',jsonb_build_object('workflow_run_id',r,'channel','voice'));
 RETURN r;
END; $$;
REVOKE ALL ON FUNCTION start_aurix_voice(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION aurix_human_hold() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.workflow_state='human_hold' AND OLD.workflow_state<>'human_hold' THEN
  PERFORM public.enqueue_aurix_event(NEW.installation_id,NEW.lead_id,'human-hold:'||coalesce(NEW.workflow_run_id::text,NEW.lead_id::text),
   'handoff.requested','{"reason":"Automation paused for human review. Inspect Seldon contact and workflow history."}');
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER aurix_human_hold AFTER UPDATE ON aurix_lead_links FOR EACH ROW EXECUTE FUNCTION aurix_human_hold();
