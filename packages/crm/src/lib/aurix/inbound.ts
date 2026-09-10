import { sql, and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { workflowWaits } from '@/db/schema';
import { resumeWait } from '@/lib/workflow/runtime';
import { DrizzleRuntimeStorage } from '@/lib/workflow/storage-drizzle';
import { makeAgentToolInvoker } from '@/lib/agents/tool-invoker';
import { aurixSchemaReady } from './schema-ready';
import { aurixSmsHold } from './sms-hold';

/** Called only after verifying the Twilio signature for the mapped workspace. */
export async function managedInbound(input: {
  orgId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  externalMessageId: string;
  /** When the webhook already created the durable provider receipt, reuse it
   * instead of inserting a second sms_messages row. */
  persistedMessageId?: string;
}) {
  const hold = await aurixSmsHold(input.orgId, input.fromNumber);
  if (!hold) return false;

  let messageId = input.persistedMessageId ?? null;
  if (messageId) {
    await db.execute(sql`UPDATE sms_messages
      SET contact_id=${hold.contactId}::uuid,
          metadata=metadata || ${JSON.stringify({ aurix: { human_hold: !hold.runId, ambiguous_identity: hold.ambiguous } })}::jsonb,
          updated_at=now()
      WHERE id=${messageId}::uuid AND org_id=${input.orgId}::uuid`);
  } else {
    // Legacy/direct callers still get the same provider-idempotent receipt.
    const result = await db.execute(sql`INSERT INTO sms_messages(org_id,contact_id,provider,direction,from_number,to_number,body,status,external_message_id,segments,metadata)
      VALUES(${input.orgId}::uuid,${hold.contactId}::uuid,'twilio','inbound',${input.fromNumber},${input.toNumber},${input.body},'received',${input.externalMessageId},1,
      ${JSON.stringify({aurix:{human_hold:!hold.runId,ambiguous_identity:hold.ambiguous}})}::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`);
    messageId = typeof result.rows[0]?.id === 'string' ? result.rows[0].id : null;
  }

  if (!messageId || !hold.runId || !hold.contactId) return true;
  const waits = await db.select().from(workflowWaits).where(and(eq(workflowWaits.runId,hold.runId),eq(workflowWaits.eventType,'sms.replied'),isNull(workflowWaits.resumedAt)));
  if (waits.length !== 1) {
    await db.execute(sql`UPDATE aurix_lead_links SET workflow_state='human_hold',updated_at=now() WHERE workflow_run_id=${hold.runId}::uuid`);
    return true;
  }
  await resumeWait({ storage:new DrizzleRuntimeStorage(db),invokeTool:makeAgentToolInvoker(input.orgId),now:()=>new Date() },
    waits[0], 'event_match', null, { smsMessageId:messageId,contactId:hold.contactId,phone:input.fromNumber,conversationId:null });
  return true;
}

export async function verifiedOptIn(orgId: string, phone: string, messageId: string, provider: {accountSid:string;to:string;authToken:string}) {
  if (!await aurixSchemaReady()) return false;
  const managed = await db.execute(sql`SELECT 1 FROM aurix_lead_links WHERE org_id=${orgId}::uuid AND phone=${phone} LIMIT 1`);
  if (!managed.rows.length) return false;
  // Provider retries must reuse the stored evidence timestamp.
  const old = await db.execute(sql`SELECT evidence FROM aurix_consent_receipts WHERE org_id=${orgId}::uuid AND receipt_id=${messageId}`);
  const { fetchConsentEvidence } = await import('./consent');
  const evidence = old.rows[0]?.evidence ?? await fetchConsentEvidence({...provider,messageId,from:phone});
  await db.execute(sql`SELECT aurix_explicit_opt_in(${orgId}::uuid,${messageId},${phone},${JSON.stringify(evidence)}::jsonb)`);
  return true;
}
