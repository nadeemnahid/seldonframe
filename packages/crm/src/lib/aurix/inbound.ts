import { sql, and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { workflowWaits } from '@/db/schema';
import { resumeWait } from '@/lib/workflow/runtime';
import { DrizzleRuntimeStorage } from '@/lib/workflow/storage-drizzle';
import { makeAgentToolInvoker } from '@/lib/agents/tool-invoker';
import { aurixSmsHold } from './sms-hold';

/** Called only after verifying the Twilio signature for the mapped workspace. */
export async function managedInbound(input: { orgId: string; fromNumber: string; toNumber: string; body: string; externalMessageId: string }) {
  const hold = await aurixSmsHold(input.orgId, input.fromNumber);
  if (!hold) return false;
  // Persist before runtime advancement. A duplicate provider delivery never
  // advances a second turn. Interrupted advances become a visible human hold.
  const result = await db.execute(sql`INSERT INTO sms_messages(org_id,contact_id,provider,direction,from_number,to_number,body,status,external_message_id,segments,metadata)
    VALUES(${input.orgId}::uuid,${hold.contactId}::uuid,'twilio','inbound',${input.fromNumber},${input.toNumber},${input.body},'received',${input.externalMessageId},1,
    ${JSON.stringify({aurix:{human_hold:!hold.runId,ambiguous_identity:hold.ambiguous}})}::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`);
  const messageId = result.rows[0]?.id;
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

export async function verifiedOptIn(orgId: string, phone: string, messageId: string) {
  // Provider retries must reuse the stored evidence timestamp.
  const old = await db.execute(sql`SELECT evidence FROM aurix_consent_receipts WHERE org_id=${orgId}::uuid AND receipt_id=${messageId}`);
  const evidence = old.rows[0]?.evidence ?? {status:'allowed',explicit:true,captured_at:new Date().toISOString(),source:'twilio_verified_start'};
  await db.execute(sql`SELECT aurix_explicit_opt_in(${orgId}::uuid,${messageId},${phone},${JSON.stringify(evidence)}::jsonb)`);
}
