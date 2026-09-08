import { sql } from 'drizzle-orm';
import { db } from '@/db';

/** Deploy code first with flags off, then migrate. Once tables exist, protective
 * routing remains active regardless of the intake/execution switches. */
export async function aurixSchemaReady() {
  const result=await db.execute(sql`SELECT to_regclass('public.aurix_lead_links') IS NOT NULL
    AND to_regclass('public.aurix_consent_receipts') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='aurix_human_hold' AND tgrelid=to_regclass('public.aurix_lead_links')) AS ready`);
  if(result.rows[0]?.ready===true) return true;
  if([process.env.AURIX_INGRESS_ENABLED,process.env.AURIX_EXECUTION_ENABLED,process.env.AURIX_CALLBACKS_ENABLED].includes('true')) {
    throw new Error('aurix_migrations_required');
  }
  // Migration 0079 alone already owns contacts. Never bypass those holds while
  // 0080 is pending; reject until the dependent schema is in place.
  const existing=await db.execute(sql`SELECT to_regclass('public.aurix_lead_links') IS NOT NULL AS managed`);
  if(existing.rows[0]?.managed===true) throw new Error('aurix_execution_migration_required');
  return false;
}
