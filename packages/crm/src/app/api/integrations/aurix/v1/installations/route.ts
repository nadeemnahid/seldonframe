import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { resolveV1Identity } from '@/lib/auth/v1-identity';
import { encryptValue } from '@/lib/encryption';
import { callbackUrl } from '@/lib/aurix/callback-policy';
import { readBody, uuid } from '@/lib/aurix/protocol';

export const runtime = 'nodejs';

// Configuration and keys require a real workspace owner, not a shared workspace
// bearer or ordinary member. Machine lead delivery has separate HMAC authentication.
async function owner(request: Request, orgId: string) {
  const auth = await resolveV1Identity(request);
  if (!auth.ok) return auth.response;
  if (auth.identity.kind !== 'user') return Response.json({error:'owner_required'},{status:403});
  const row = await db.execute(sql`SELECT id FROM organizations WHERE id=${orgId}::uuid AND owner_id=${auth.identity.userId}::uuid`);
  return row.rows.length ? null : Response.json({error:'owner_required'},{status:403});
}

export async function POST(request: Request) {
  try {
    const value: unknown = JSON.parse(await readBody(request,32768));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Response.json({error:'invalid_payload'},{status:422});
    const p = value as Record<string,unknown>;
    if (typeof p.workspace_id !== 'string' || !uuid.test(p.workspace_id) || typeof p.installation_id !== 'string' || !uuid.test(p.installation_id)) return Response.json({error:'invalid_identity'},{status:422});
    const denied = await owner(request,p.workspace_id); if (denied) return denied;
    if (p.action === 'provision') {
      if (typeof p.aurix_org_id !== 'string' || !uuid.test(p.aurix_org_id) || typeof p.inbound_secret !== 'string' || p.inbound_secret.length<32 ||
          typeof p.outbound_secret !== 'string' || p.outbound_secret.length<32 || p.inbound_secret === p.outbound_secret ||
          typeof p.key_id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(p.key_id)) return Response.json({error:'invalid_keys'},{status:422});
      const url = callbackUrl(String(p.callback_url),process.env.AURIX_CALLBACK_HOSTS ?? '');
      const result = await db.execute(sql`WITH i AS (
        INSERT INTO aurix_installations(id,org_id,aurix_org_id,callback_url) VALUES(${p.installation_id}::uuid,${p.workspace_id}::uuid,${p.aurix_org_id}::uuid,${url})
        ON CONFLICT DO NOTHING RETURNING id
      ) INSERT INTO aurix_keys(installation_id,key_id,direction,encrypted_secret)
       SELECT i.id,${p.key_id},v.direction,v.secret FROM i CROSS JOIN (VALUES
       ('inbound',${encryptValue(p.inbound_secret)}),('outbound',${encryptValue(p.outbound_secret)})) v(direction,secret) RETURNING direction`);
      return Response.json({status:result.rows.length?'draft':'already_exists'});
    }
    const existing = await db.execute(sql`SELECT status FROM aurix_installations WHERE id=${p.installation_id}::uuid AND org_id=${p.workspace_id}::uuid`);
    if (!existing.rows.length) return Response.json({error:'not_found'},{status:404});
    if (p.action === 'configure') {
      const c = p.config;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return Response.json({error:'invalid_config'},{status:422});
      const config = c as Record<string,unknown>;
      if (typeof config.timezone !== 'string' || typeof config.appointment_type_id !== 'string' || !uuid.test(config.appointment_type_id) ||
          !Array.isArray(config.service_postal_codes) || !config.service_postal_codes.length || config.service_postal_codes.some(x=>typeof x !== 'string'||!/^\d{5}$/.test(x))) return Response.json({error:'calendar_and_zip_list_required'},{status:422});
      new Intl.DateTimeFormat('en-US',{timeZone:config.timezone});
      const template = await db.execute(sql`SELECT id FROM bookings WHERE id=${config.appointment_type_id}::uuid AND org_id=${p.workspace_id}::uuid AND status='template'`);
      if (!template.rows.length) return Response.json({error:'calendar_not_in_workspace'},{status:422});
      // Reconfiguration always pauses execution and invalidates old QA evidence.
      await db.execute(sql`UPDATE aurix_installations SET status=CASE WHEN status='draft' THEN 'draft' ELSE 'paused' END,qa_evidence=NULL,
        config=${JSON.stringify({timezone:config.timezone,appointment_type_id:config.appointment_type_id,service_postal_codes:config.service_postal_codes,execution_enabled:false,primary_channel:config.primary_channel === "voice" ? "voice" : "sms"})}::jsonb
        WHERE id=${p.installation_id}::uuid AND org_id=${p.workspace_id}::uuid`);
    } else if (p.action === 'pause') {
      await db.execute(sql`UPDATE aurix_installations SET status='paused',config=jsonb_set(config,'{execution_enabled}','false') WHERE id=${p.installation_id}::uuid AND org_id=${p.workspace_id}::uuid`);
    } else if (p.action === 'rotate_key') {
      if (!['inbound','outbound'].includes(String(p.direction)) || typeof p.key_id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(p.key_id) ||
          typeof p.secret !== 'string' || p.secret.length<32) return Response.json({error:'invalid_key'},{status:422});
      const keys = await db.execute(sql`SELECT encrypted_secret FROM aurix_keys WHERE installation_id=${p.installation_id}::uuid AND direction<>${p.direction} AND status<>'revoked'`);
      const { decryptValue } = await import('@/lib/encryption');
      if (keys.rows.some(k=>typeof k.encrypted_secret==='string' && decryptValue(k.encrypted_secret)===p.secret)) return Response.json({error:'directional_secrets_must_differ'},{status:422});
      await db.execute(sql`WITH retired AS (UPDATE aurix_keys SET status='retiring',valid_until=now()+interval '1 hour'
        WHERE installation_id=${p.installation_id}::uuid AND direction=${p.direction} AND status='active' RETURNING key_id)
        INSERT INTO aurix_keys(installation_id,key_id,direction,encrypted_secret) VALUES(${p.installation_id}::uuid,${p.key_id},${p.direction},${encryptValue(p.secret)})`);
    } else if (p.action === 'revoke_key') {
      if (!['inbound','outbound'].includes(String(p.direction)) || typeof p.key_id !== 'string') return Response.json({error:'invalid_key'},{status:422});
      await db.execute(sql`UPDATE aurix_keys SET status='revoked',valid_until=now() WHERE installation_id=${p.installation_id}::uuid AND direction=${p.direction} AND key_id=${p.key_id}`);
    } else if (p.action === 'retry_delivery') {
      if (p.confirmation !== 'RETRY_AURIX_CALLBACK' || typeof p.event_id !== 'string') return Response.json({error:'explicit_retry_required'},{status:422});
      const rows=await db.execute(sql`UPDATE aurix_callback_outbox SET status='retry',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL
        WHERE installation_id=${p.installation_id}::uuid AND event_id=${p.event_id} AND status='dead'
        AND (last_error IN ('network_failure','network_or_ack_failure','lease_expired','callback_destination_not_allowed','callback_key_or_destination_missing')
         OR last_error LIKE 'http_5%') RETURNING event_id`);
      if (!rows.rows.length) return Response.json({error:'terminal_event_or_not_found'},{status:409});
    } else if (p.action === 'activate') {
      if (p.confirmation !== 'ACTIVATE_AURIX_INTEGRATION' || !Array.isArray(p.evidence_urls) || p.evidence_urls.length<2 ||
          p.evidence_urls.some(x=>typeof x !== 'string'||!x.startsWith('https://')) || p.staging_passed !== true) return Response.json({error:'qa_evidence_required'},{status:422});
      const activated = await db.execute(sql`UPDATE aurix_installations i SET status='active',config=jsonb_set(config,'{execution_enabled}','true'),
       qa_evidence=${JSON.stringify({evidence_urls:p.evidence_urls,staging_passed:true,recorded_at:new Date().toISOString()})}::jsonb
       WHERE id=${p.installation_id}::uuid AND org_id=${p.workspace_id}::uuid AND callback_url IS NOT NULL
       AND config ? 'appointment_type_id' AND config ? 'service_postal_codes'
       AND (SELECT count(DISTINCT direction) FROM aurix_keys k WHERE k.installation_id=i.id AND k.status='active'
        AND k.valid_from<=now() AND (k.valid_until IS NULL OR k.valid_until>now()))=2 RETURNING id`);
      if (!activated.rows.length) return Response.json({error:'activation_dependencies_missing'},{status:409});
    } else return Response.json({error:'unsupported_action'},{status:422});
    return Response.json({status:'recorded'});
  } catch {
    return Response.json({error:'configuration_rejected'},{status:422});
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const orgId = params.get('workspace_id');
  if (!orgId || !uuid.test(orgId)) return Response.json({error:'workspace_required'},{status:422});
  const denied = await owner(request,orgId); if (denied) return denied;
  const result = await db.execute(sql`SELECT i.id,i.status,i.config,i.qa_evidence,
    (SELECT count(*) FROM aurix_lead_links l WHERE l.installation_id=i.id) AS synced_leads,
    (SELECT count(*) FROM aurix_lead_links l WHERE l.installation_id=i.id AND l.workflow_state IN ('human_hold','hold_for_consent')) AS held_leads,
    (SELECT jsonb_object_agg(s.status,s.n) FROM (SELECT status,count(*) n FROM aurix_callback_outbox WHERE installation_id=i.id GROUP BY status) s) AS callbacks,
    (SELECT min(created_at) FROM aurix_callback_outbox WHERE installation_id=i.id AND status<>'delivered') AS oldest_pending,
    (SELECT jsonb_agg(d) FROM (SELECT event_id,event_type,last_error,attempts FROM aurix_callback_outbox WHERE installation_id=i.id AND status='dead' ORDER BY id LIMIT 20) d) AS dead_letters
    FROM aurix_installations i WHERE i.org_id=${orgId}::uuid`);
  return Response.json({installations:result.rows});
}
