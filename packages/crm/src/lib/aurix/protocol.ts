import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export class AurixError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9._:-]{1,200}$/;
export const hash = (body: string) => createHash("sha256").update(body).digest("hex");
export function signature(secret: string, timestamp: string, messageId: string, body: string) {
  return "v1=" + createHmac("sha256", secret).update(`${timestamp}\n${messageId}\n${hash(body)}`).digest("hex");
}
export function parseHeaders(headers: Headers, now = Date.now()) {
  const installationId = headers.get("x-installation-id") ?? "";
  const messageId = headers.get("x-message-id") ?? "";
  const keyId = headers.get("x-key-id") ?? "";
  const timestamp = headers.get("x-timestamp") ?? "";
  const supplied = headers.get("x-signature") ?? "";
  if (headers.get("x-integration-version") !== "1" || !uuid.test(installationId) ||
      !token.test(messageId) || !token.test(keyId) || !/^\d{10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(supplied)) {
    throw new AurixError("invalid_headers", 401);
  }
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) throw new AurixError("expired_request", 401);
  return { installationId, messageId, keyId, timestamp, supplied };
}
export function verify(headers: ReturnType<typeof parseHeaders>, body: string, secret: string) {
  const expected = signature(secret, headers.timestamp, headers.messageId, body);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(headers.supplied))) throw new AurixError("invalid_signature", 401);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AurixError("invalid_payload", 422);
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AurixError("invalid_payload", 422);
  return value;
}
export function parseLead(raw: string, installationId: string) {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new AurixError("invalid_json", 422); }
  const payload = record(decoded), lead = record(payload.lead), contact = record(lead.contact);
  const person = record(lead.person), consent = record(lead.consent), workflow = record(payload.workflow);
  const leadId = text(lead.id), phone = text(contact.phone);
  const updatedAt = text(lead.updated_at);
  if (payload.schema_version !== "1.0" || payload.installation_id !== installationId || !uuid.test(leadId) ||
      !/^\+[1-9]\d{7,14}$/.test(phone) || !Number.isFinite(Date.parse(updatedAt)) ||
      !["allowed", "denied", "unknown"].includes(String(consent.sms_status)) ||
      workflow.key !== "roofing_qualification" || workflow.version !== "1" ||
      !["if_not_started", "hold_for_consent"].includes(String(workflow.start_mode))) {
    throw new AurixError("invalid_payload", 422);
  }
  // A lead sync may preserve or deny consent; it never clears a local STOP.
  const consentEvidence = consent.sms_status === "allowed" && typeof consent.captured_at === "string" &&
    Number.isFinite(Date.parse(consent.captured_at)) && Date.parse(consent.captured_at) <= Date.now() &&
    typeof consent.source === "string" && consent.source.trim().length > 0;
  return { payload, leadId, phone, firstName: text(person.first_name),
    lastName: typeof person.last_name === "string" ? person.last_name.slice(0, 500) : null,
    updatedAt, consentAllowed: Boolean(consentEvidence) && workflow.start_mode === "if_not_started" };
}
export async function readBody(request: Request, limit = 131072) {
  if (!request.body) throw new AurixError("empty_body", 422);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new AurixError("body_too_large", 413); }
    chunks.push(value);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new AurixError("invalid_utf8", 422); }
}
