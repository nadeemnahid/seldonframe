import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { advanceRun } from '@/lib/workflow/runtime';
import { DrizzleRuntimeStorage } from '@/lib/workflow/storage-drizzle';
import { makeAgentToolInvoker } from '@/lib/agents/tool-invoker';
import { roofingEvidence, roofingSpec } from './roofing';
import { callbackTick } from './callbacks';

export async function reportRoofing(orgId: string, runId: string, args: Record<string, unknown>) {
  const result = await db.execute(sql`SELECT i.config FROM aurix_lead_links l JOIN aurix_installations i ON i.id=l.installation_id
    WHERE l.org_id=${orgId}::uuid AND l.workflow_run_id=${runId}::uuid AND i.status='active' AND l.workflow_state IN ('running','completed','human_hold')`);
  const config = result.rows[0]?.config;
  if (!config || typeof config !== 'object') throw new Error('aurix_identity_or_pause_conflict');
  const zips = 'service_postal_codes' in config && Array.isArray(config.service_postal_codes)
    ? config.service_postal_codes.filter((x): x is string => typeof x === 'string') : [];
  const evidence = roofingEvidence(args, runId, zips);
  await db.execute(sql`SELECT finish_aurix_qualification(${runId}::uuid,${JSON.stringify(evidence.data)}::jsonb,${evidence.handoff})`);
  return { data: { reported: true, human_hold: evidence.handoff } };
}

export async function aurixTick() {
  const callbacks = await callbackTick(5);
  let started = 0;
  if (process.env.AURIX_EXECUTION_ENABLED !== 'true') return { callbacks, started };
  // Stale execution may have reached the SMS provider before crashing. Never
  // resend blindly: move to human review and emit a durable failure callback.
  await db.execute(sql`UPDATE workflow_runs SET status='failed',updated_at=now()
    WHERE ((archetype_id='aurix-roofing-v1' AND status='running') OR (archetype_id='aurix-roofing-voice-v1' AND status='waiting')) AND updated_at<now()-interval '5 minutes'`);
  const candidates = await db.execute(sql`SELECT l.installation_id,l.lead_id,l.org_id FROM aurix_lead_links l
    JOIN aurix_installations i ON i.id=l.installation_id WHERE i.status='active'
    AND i.config->>'execution_enabled'='true' AND coalesce(i.config->>'primary_channel','sms')='sms' AND l.workflow_state='hold_for_qa' AND l.workflow_run_id IS NULL LIMIT 3`);
  for (const l of candidates.rows) {
    const result = await db.execute(sql`SELECT start_aurix_workflow(${l.installation_id}::uuid,${l.lead_id}::uuid,${JSON.stringify(roofingSpec())}::jsonb) AS run_id`);
    const runId = result.rows[0]?.run_id;
    if (typeof runId !== 'string' || typeof l.org_id !== 'string') continue;
    started++;
    await advanceRun({ storage: new DrizzleRuntimeStorage(db), invokeTool: makeAgentToolInvoker(l.org_id), now: () => new Date() }, runId);
  }
  const { bookAcknowledgedQualifications } = await import('./booking');
  const booking = await bookAcknowledgedQualifications();
  return { callbacks, started, booking };
}

export async function withAurixRunLease(runId: string, execute: () => Promise<void>) {
  const claimed=await db.execute(sql`UPDATE aurix_lead_links SET execution_lease_until=now()+interval '5 minutes'
    WHERE workflow_run_id=${runId}::uuid AND workflow_state='running' AND execution_lease_until IS NULL RETURNING lead_id`);
  if (!claimed.rows.length) return;
  try { await execute(); }
  finally { await db.execute(sql`UPDATE aurix_lead_links SET execution_lease_until=NULL WHERE workflow_run_id=${runId}::uuid`); }
}
