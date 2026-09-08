import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { decryptValue } from '@/lib/encryption';
import { callbackHeaders, callbackUrl, deliveryDecision } from './callback-policy';

export async function queueEvent(installationId: string, leadId: string, source: string, type: string, data: Record<string, unknown>) {
  const result = await db.execute(sql`SELECT enqueue_aurix_event(${installationId}::uuid,${leadId}::uuid,${source},${type},${JSON.stringify(data)}::jsonb) AS event_id`);
  return result.rows[0]?.event_id;
}

export async function callbackTick(limit = 20) {
  const summary = { delivered: 0, retry: 0, dead: 0 };
  if (process.env.AURIX_CALLBACKS_ENABLED !== 'true') return summary;
  // Lease expiry reclaims the same immutable bytes. One outstanding event per
  // installation preserves STOP/opt-in and booking creation/mutation order.
  await db.execute(sql`UPDATE aurix_callback_outbox SET status=CASE WHEN attempts>=12 THEN 'dead' ELSE 'retry' END,
    lease_token=NULL,lease_until=NULL,last_error='lease_expired' WHERE status='processing' AND lease_until<now()`);
  for (let n = 0; n < limit; n++) {
    const lease = randomUUID();
    const claimed = await db.execute(sql`
      WITH candidate AS (
       SELECT o.id FROM aurix_callback_outbox o JOIN aurix_installations i ON i.id=o.installation_id
       WHERE o.status IN ('pending','retry') AND o.available_at<=now() AND i.status='active'
       AND NOT EXISTS(SELECT 1 FROM aurix_callback_outbox prior WHERE prior.installation_id=o.installation_id
         AND prior.id<o.id AND prior.status<>'delivered')
       ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
      ) UPDATE aurix_callback_outbox o SET status='processing',attempts=attempts+1,
       lease_token=${lease}::uuid,lease_until=now()+interval '60 seconds'
       FROM candidate c WHERE o.id=c.id RETURNING o.*`);
    const row = claimed.rows[0];
    if (!row) break;
    let httpStatus = 0, errorCode = 'network_failure';
    let success = false; let acknowledged: unknown = null;
    try {
      const keys = await db.execute(sql`SELECT i.callback_url,k.key_id,k.encrypted_secret FROM aurix_installations i
        JOIN aurix_keys k ON k.installation_id=i.id WHERE i.id=${row.installation_id}::uuid AND i.status='active'
        AND k.direction='outbound' AND k.status='active' AND k.valid_from<=now() AND (k.valid_until IS NULL OR k.valid_until>now())
        ORDER BY k.valid_from DESC,k.key_id LIMIT 1`);
      const key = keys.rows[0];
      if (!key || typeof key.callback_url !== 'string' || typeof key.key_id !== 'string' || typeof key.encrypted_secret !== 'string') {
        throw new Error('callback_key_or_destination_missing');
      }
      const url = callbackUrl(key.callback_url, process.env.AURIX_CALLBACK_HOSTS ?? '');
      if (typeof row.raw_body !== 'string' || typeof row.event_id !== 'string' || typeof row.installation_id !== 'string') throw new Error('invalid_outbox_row');
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: callbackHeaders({ installationId: row.installation_id, eventId: row.event_id, keyId: key.key_id,
          secret: decryptValue(key.encrypted_secret), rawBody: row.raw_body }), body: row.raw_body });
      httpStatus = response.status;
      // Aurix sends JSON acknowledgements; an HTML login page is not delivery.
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        const raw = await response.text();
        if (raw.length < 32768) {
          const ack: unknown = JSON.parse(raw);
          success = Boolean(ack && typeof ack === 'object' && 'status' in ack &&
            ['processed','already_processed'].includes(String(ack.status)) && 'event_id' in ack && ack.event_id === row.event_id && 'message_id' in ack && ack.message_id === row.event_id);
          if (success && ack && typeof ack === 'object' && 'result' in ack) acknowledged = ack.result;
        }
      }
      if (!success && httpStatus >= 200 && httpStatus < 300) httpStatus = 0;
      if (!success) errorCode = `http_${httpStatus}_unacknowledged`;
    } catch (error) {
      // Never persist arbitrary exception strings (URLs, payloads or secrets).
      errorCode = error instanceof Error && ['callback_destination_not_allowed','callback_key_or_destination_missing','invalid_outbox_row'].includes(error.message)
        ? error.message : 'network_or_ack_failure';
    }
    const decision = success ? { status: 'delivered' as const, delaySeconds: 0 } : deliveryDecision(httpStatus, Number(row.attempts));
    await db.execute(sql`UPDATE aurix_callback_outbox SET status=${decision.status},
      available_at=now()+${decision.delaySeconds}*interval '1 second',lease_token=NULL,lease_until=NULL,
      acknowledged_result=coalesce(${acknowledged ? JSON.stringify(acknowledged) : null}::jsonb,acknowledged_result),
      delivered_at=CASE WHEN ${success} THEN now() ELSE NULL END,last_error=${success ? null : errorCode}
      WHERE id=${row.id} AND lease_token=${lease}::uuid AND status='processing'`);
    summary[decision.status]++;
  }
  return summary;
}
