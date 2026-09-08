import { sql } from 'drizzle-orm';
import { db } from '@/db';

export async function managedSmsGuard(orgId: string, contactId: string | null, phone: string) {
  const result = await db.execute(sql`SELECT l.contact_id,l.phone,l.workflow_state,l.context,l.consent_override,i.status,i.config
    FROM aurix_lead_links l JOIN aurix_installations i ON i.id=l.installation_id
    WHERE l.org_id=${orgId}::uuid AND (l.phone=${phone} OR l.contact_id=${contactId}::uuid)`);
  if (!result.rows.length) return null;
  const l = result.rows[0];
  if (result.rows.length !== 1 || l.contact_id !== contactId || l.phone !== phone) return 'aurix_ambiguous_identity';
  if (process.env.AURIX_EXECUTION_ENABLED !== 'true' || l.status !== 'active' ||
      !l.config || typeof l.config !== 'object' || !('execution_enabled' in l.config) || l.config.execution_enabled !== true) return 'aurix_execution_paused';
  if (!['running','completed'].includes(String(l.workflow_state))) return 'aurix_human_or_consent_hold';
  const suppressed = await db.execute(sql`SELECT 1 FROM suppression_list WHERE org_id=${orgId}::uuid AND phone=${phone} AND channel='sms' LIMIT 1`);
  return suppressed.rows.length ? 'aurix_sms_suppressed' : null;
}

export async function aurixSmsHold(orgId: string, phone: string) {
  const result = await db.execute(sql`SELECT contact_id,workflow_run_id,workflow_state FROM aurix_lead_links WHERE org_id=${orgId}::uuid AND phone=${phone}`);
  if (!result.rows.length) return null;
  const contactId = result.rows.length === 1 && typeof result.rows[0].contact_id === 'string' ? result.rows[0].contact_id : null;
  const runId = result.rows.length === 1 && typeof result.rows[0].workflow_run_id === 'string' ? result.rows[0].workflow_run_id : null;
  const reason = await managedSmsGuard(orgId, contactId, phone);
  const canResume = !reason && result.rows[0].workflow_state === 'running' && runId;
  if (!canResume) {
    // Do not overwrite a STOP hold with a less restrictive state.
    await db.execute(sql`UPDATE aurix_lead_links SET workflow_state=CASE WHEN workflow_state='hold_for_consent' THEN workflow_state ELSE 'human_hold' END,updated_at=now()
      WHERE org_id=${orgId}::uuid AND phone=${phone}`);
  }
  return { contactId, runId: canResume ? runId : null, ambiguous: !contactId };
}
