import crypto from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { verifyTwilioSignature } from "@/lib/sms/webhook-verify";

const originalBase = process.env.TWILIO_WEBHOOK_BASE_URL;

before(() => {
  process.env.TWILIO_WEBHOOK_BASE_URL = "https://seldon-staging.aurixcrm.com";
});

after(() => {
  if (originalBase === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
  else process.env.TWILIO_WEBHOOK_BASE_URL = originalBase;
});

function sign(authToken: string, url: string, body: URLSearchParams) {
  const keys = [...new Set(body.keys())].sort();
  let payload = url;
  for (const key of keys) {
    for (const value of [...new Set(body.getAll(key))].sort()) payload += key + value;
  }
  return crypto.createHmac("sha1", authToken).update(payload).digest("base64");
}

test("Twilio signature verification uses the configured public webhook origin", () => {
  const authToken = "test-auth-token";
  const body = new URLSearchParams([
    ["CallStatus", "ringing"],
    ["From", "+919999999999"],
    ["To", "+15555550123"],
    ["CallSid", "CA11111111111111111111111111111111"],
  ]);
  const publicUrl = "https://seldon-staging.aurixcrm.com/api/webhooks/twilio/voice";
  const signature = sign(authToken, publicUrl, body);

  assert.equal(
    verifyTwilioSignature({
      url: "http://seldon-staging-app:3200/api/webhooks/twilio/voice",
      body,
      signature,
      authToken,
    }),
    true,
  );
});

test("Twilio signature verification matches sorted unique duplicate form values", () => {
  const authToken = "test-auth-token";
  const body = new URLSearchParams([
    ["Digits", "2"],
    ["Digits", "1"],
    ["Digits", "2"],
    ["CallSid", "CA22222222222222222222222222222222"],
  ]);
  const publicUrl = "https://seldon-staging.aurixcrm.com/api/webhooks/twilio/voice";
  const signature = sign(authToken, publicUrl, body);

  assert.equal(
    verifyTwilioSignature({
      url: "http://internal:3200/api/webhooks/twilio/voice",
      body,
      signature,
      authToken,
    }),
    true,
  );
});

test("Twilio signature verification rejects an invalid signature", () => {
  const body = new URLSearchParams({ CallSid: "CA33333333333333333333333333333333" });
  assert.equal(
    verifyTwilioSignature({
      url: "http://internal:3200/api/webhooks/twilio/voice",
      body,
      signature: "not-a-valid-signature",
      authToken: "test-auth-token",
    }),
    false,
  );
});
