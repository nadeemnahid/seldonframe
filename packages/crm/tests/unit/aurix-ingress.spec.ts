import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleLead, type IngressStore } from "../../src/lib/aurix/ingress";
import { AurixError, parseLead, signature } from "../../src/lib/aurix/protocol";

const installation = "00000000-0000-4000-8000-000000000001";
const leadId = "00000000-0000-4000-8000-000000000002";
const secret = "test-only-directional-key";
const payload = {
  schema_version: "1.0", installation_id: installation,
  lead: { id: leadId, updated_at: "2026-01-01T00:00:00Z", person: { first_name: "Test", last_name: "Lead" },
    contact: { phone: "+12025550123", email: "same@example.test" },
    consent: { sms_status: "allowed", captured_at: "2026-01-01T00:00:00Z", source: "test_form" } },
  workflow: { key: "roofing_qualification", version: "1", start_mode: "if_not_started" },
};
function request(raw = JSON.stringify(payload), overrides: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000)), messageId = "message_1";
  return new Request("https://example.test/api/integrations/aurix/v1/leads", { method: "POST", body: raw, headers: {
    "x-integration-version": "1", "x-installation-id": installation,
    "x-message-id": messageId, "x-key-id": "key_1", "x-timestamp": timestamp,
    "x-signature": signature(secret, timestamp, messageId, raw), ...overrides,
  } });
}
function fakeStore() {
  let reads = 0, writes = 0;
  const receipts = new Map<string, { body: string; result: object }>();
  const contacts = new Map<string, string>();
  const store: IngressStore = {
    async getInboundSecret(id, key) { reads++; return id === installation && key === "key_1" ? secret : null; },
    async accept(input) {
      writes++;
      const previous = receipts.get(input.messageId);
      if (previous) {
        if (previous.body !== input.rawBody) throw new AurixError("message_body_conflict", 409);
        return previous.result;
      }
      let contact = contacts.get(input.leadId);
      if (!contact) { contact = `contact_${contacts.size + 1}`; contacts.set(input.leadId, contact); }
      const result = { status: "created", lead_id: input.leadId, contact_id: contact };
      receipts.set(input.messageId, { body: input.rawBody, result }); return result;
    },
  };
  return { store, contacts, reads: () => reads, writes: () => writes };
}
test("valid request and exact retry return the same identity", async () => {
  const f = fakeStore();
  const first = await handleLead(request(), f.store), retry = await handleLead(request(), f.store);
  assert.equal(first.status, 200); assert.deepEqual(await first.json(), await retry.json());
  assert.equal(f.contacts.size, 1);
});
test("same message with different signed bytes conflicts", async () => {
  const f = fakeStore(); await handleLead(request(), f.store);
  assert.equal((await handleLead(request(JSON.stringify(payload, null, 2)), f.store)).status, 409);
});
for (const delta of [-301, 301]) test(`rejects clock skew ${delta} before database reads`, async () => {
  const f = fakeStore();
  assert.equal((await handleLead(request(undefined, { "x-timestamp": String(Math.floor(Date.now()/1000)+delta) }), f.store)).status, 401);
  assert.equal(f.reads(), 0);
});
const malformedHeaders: Record<string, string>[] = [
  { "x-installation-id": "invalid" }, { "x-message-id": "bad message" },
  { "x-signature": "v1=bad" }, { "x-integration-version": "2" },
];
for (const headers of malformedHeaders) test(`rejects malformed header ${Object.keys(headers)[0]} before reads`, async () => {
  const f = fakeStore(); assert.equal((await handleLead(request(undefined, headers), f.store)).status, 401);
  assert.equal(f.reads(), 0);
});
test("wrong key ID and tampered signature cannot write", async () => {
  const cases: Record<string, string>[] = [{ "x-key-id": "other" }, { "x-signature": "v1=" + "0".repeat(64) }];
  for (const headers of cases) {
    const f = fakeStore(); assert.equal((await handleLead(request(undefined, headers), f.store)).status, 401);
    assert.equal(f.writes(), 0);
  }
});
test("body installation mismatch cannot write", async () => {
  const f = fakeStore();
  assert.equal((await handleLead(request(JSON.stringify({ ...payload, installation_id: leadId })), f.store)).status, 422);
  assert.equal(f.writes(), 0);
});
test("same phone and email do not determine identity", async () => {
  const f = fakeStore(); await handleLead(request(), f.store);
  const raw = JSON.stringify({ ...payload, lead: { ...payload.lead, id: "00000000-0000-4000-8000-000000000003" } });
  const timestamp = String(Math.floor(Date.now()/1000));
  const second = request(raw, { "x-message-id": "message_2", "x-timestamp": timestamp,
    "x-signature": signature(secret, timestamp, "message_2", raw) });
  assert.equal((await handleLead(second, f.store)).status, 200); assert.equal(f.contacts.size, 2);
});
test("missing consent evidence forces hold", () => {
  const raw = JSON.stringify({ ...payload, lead: { ...payload.lead, consent: { sms_status: "allowed" } } });
  assert.equal(parseLead(raw, installation).consentAllowed, false);
});
test("oversized body is rejected before reading keys", async () => {
  const f = fakeStore(); assert.equal((await handleLead(request("x".repeat(131073)), f.store)).status, 413);
  assert.equal(f.reads(), 0);
});
test("database errors return a generic retryable response", async () => {
  const store: IngressStore = { async getInboundSecret() { throw new Error("private connection details"); }, async accept() { return null; } };
  const response = await handleLead(request(), store);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private connection/);
});
