import { sql } from "drizzle-orm";
import { db } from "@/db";
import { decryptValue } from "@/lib/encryption";
import { AurixError } from "./protocol";
import type { IngressStore } from "./ingress";

export const ingressStore: IngressStore = {
  async getInboundSecret(installationId, keyId) {
    const result = await db.execute(sql`
      SELECT k.encrypted_secret FROM aurix_keys k
      JOIN aurix_installations i ON i.id=k.installation_id
      WHERE i.id=${installationId}::uuid AND i.status='active'
        AND k.key_id=${keyId} AND k.direction='inbound'
        AND k.status IN ('active','retiring')
        AND k.valid_from <= now() AND (k.valid_until IS NULL OR k.valid_until > now())
    `);
    const row = result.rows[0];
    return row && typeof row.encrypted_secret === "string" ? decryptValue(row.encrypted_secret) : null;
  },
  async accept(input) {
    try {
      const result = await db.execute(sql`
        SELECT accept_aurix_lead(${input.installationId}::uuid,${input.messageId},${input.bodyHash},${input.rawBody},
          ${input.leadId}::uuid,${input.phone},${input.firstName},${input.lastName},
          ${input.updatedAt}::timestamptz,${input.consentAllowed}) AS response
      `);
      if (!result.rows[0]?.response) throw new AurixError("missing_receipt", 503);
      return result.rows[0].response;
    } catch (error) {
      // Drizzle wraps the Postgres error in cause. Never return database details.
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const message = cause instanceof Error ? cause.message : "";
      if (/message_body_conflict|contact_identity_conflict/.test(message)) throw new AurixError("identity_or_replay_conflict", 409);
      if (/installation_not_active/.test(message)) throw new AurixError("installation_not_active", 403);
      throw error;
    }
  },
};
