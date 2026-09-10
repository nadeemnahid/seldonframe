import crypto from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  verifyTwilioSignature,
  verifyUnsignedTwilioTrialVoiceRequest,
} from "@/lib/sms/webhook-verify";

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
  return crypto.createHmac("sha1", authToken).update(Buffer.from(payload, "utf-8")).digest("base64");
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

test("Twilio signature verification accepts the official standard-port variant", () => {
  const authToken = "test-auth-token";
  const body = new URLSearchParams([
    ["CallStatus", "ringing"],
    ["From", "+919999999999"],
    ["To", "+15555550123"],
    ["CallSid", "CA44444444444444444444444444444444"],
  ]);
  const twilioSignedUrl = "https://seldon-staging.aurixcrm.com:443/api/webhooks/twilio/voice";
  const signature = sign(authToken, twilioSignedUrl, body);

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

test("unsigned Twilio trial fallback authenticates the exact recent inbound ringing CallSid", async () => {
  const accountSid = "AC11111111111111111111111111111111";
  const callSid = "CA55555555555555555555555555555555";
  const now = new Date("2026-09-10T08:00:00Z");
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        sid: callSid,
        account_sid: accountSid,
        direction: "inbound",
        from: "+919999999999",
        to: "+15555550123",
        date_created: "Thu, 10 Sep 2026 07:59:30 +0000",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  assert.equal(
    await verifyUnsignedTwilioTrialVoiceRequest({
      enabled: true,
      accountSid,
      authToken: "primary-auth-token",
      callSid,
      bodyAccountSid: accountSid,
      callStatus: "ringing",
      direction: "inbound",
      from: "+919999999999",
      to: "+15555550123",
      now,
      fetchImpl,
    }),
    true,
  );
});

test("unsigned Twilio trial fallback is disabled by default", async () => {
  assert.equal(
    await verifyUnsignedTwilioTrialVoiceRequest({
      enabled: false,
      accountSid: "AC11111111111111111111111111111111",
      authToken: "primary-auth-token",
      callSid: "CA55555555555555555555555555555555",
      bodyAccountSid: "AC11111111111111111111111111111111",
      callStatus: "ringing",
      direction: "inbound",
      from: "+919999999999",
      to: "+15555550123",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    }),
    false,
  );
});

test("unsigned Twilio trial fallback rejects a mismatched caller", async () => {
  const accountSid = "AC11111111111111111111111111111111";
  const callSid = "CA55555555555555555555555555555555";
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        sid: callSid,
        account_sid: accountSid,
        direction: "inbound",
        from: "+918888888888",
        to: "+15555550123",
        date_created: "Thu, 10 Sep 2026 07:59:30 +0000",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  assert.equal(
    await verifyUnsignedTwilioTrialVoiceRequest({
      enabled: true,
      accountSid,
      authToken: "primary-auth-token",
      callSid,
      bodyAccountSid: accountSid,
      callStatus: "ringing",
      direction: "inbound",
      from: "+919999999999",
      to: "+15555550123",
      now: new Date("2026-09-10T08:00:00Z"),
      fetchImpl,
    }),
    false,
  );
});

test("unsigned Twilio trial fallback rejects terminal callbacks", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };

  assert.equal(
    await verifyUnsignedTwilioTrialVoiceRequest({
      enabled: true,
      accountSid: "AC11111111111111111111111111111111",
      authToken: "primary-auth-token",
      callSid: "CA55555555555555555555555555555555",
      bodyAccountSid: "AC11111111111111111111111111111111",
      callStatus: "completed",
      direction: "inbound",
      from: "+919999999999",
      to: "+15555550123",
      fetchImpl,
    }),
    false,
  );
  assert.equal(called, false);
});
