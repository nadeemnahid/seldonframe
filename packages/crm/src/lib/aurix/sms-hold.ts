import { sql } from "drizzle-orm";
import { db } from "@/db";

// Until the roofing workflow and callback round trip pass QA, managed
// contacts go to the operator inbox. Native phone-based bots must not run.
export async function aurixSmsHold(orgId: string, phone: string) {
  if (process.env.AURIX_INGRESS_ENABLED !== "true") return null;
  const result = await db.execute(sql`
    SELECT contact_id FROM aurix_lead_links WHERE org_id=${orgId}::uuid AND phone=${phone}
  `);
  if (!result.rows.length) return null;
  const contactId = result.rows.length === 1 && typeof result.rows[0].contact_id === "string"
    ? result.rows[0].contact_id : null;
  await db.execute(sql`
    UPDATE aurix_lead_links SET workflow_state='human_hold', updated_at=now()
    WHERE org_id=${orgId}::uuid AND phone=${phone}
  `);
  return { contactId, ambiguous: !contactId };
}
