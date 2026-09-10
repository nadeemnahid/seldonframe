// Twilio Voice webhook — call.missed event emitter.
//
// Thin harness, fat skill posture:
//   This route exists ONLY to translate Twilio's CallStatus signal
//   into a SeldonEvent the archetype runtime can react to. It has
//   zero business logic. The intelligence (what to text back, when,
//   in what tone) lives in:
//     - packages/crm/src/lib/agents/archetypes/missed-call-text-back.ts
//       (the spec template — wait → text → wait → log)
//     - packages/crm/src/lib/agents/skills/missed-call/
//       vertical-templates.md (the per-vertical text-back copy that
//       synthesis fills into $textBackBody)
//   When Claude / GPT / Gemini get better, the synthesized copy gets
//   better. This file doesn't need to change.

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { decryptValue } from "@/lib/encryption";
import { emitSeldonEvent } from "@/lib/events/bus";
import { logEvent } from "@/lib/observability/log";
import { findContactByPhone } from "@/lib/sms/api";
import { toE164 } from "@/lib/sms/providers";
import {
  diagnoseTwilioSignature,
  verifyTwilioSignature,
  verifyUnsignedTwilioTrialVoiceRequest,
} from "@/lib/sms/webhook-verify";
import { resolveWorkspaceByPhoneNumber } from "@/lib/agents/voice/resolve-workspace-by-number";
import {
  buildGreetingTwiml,
  buildVoiceGreeting,
  shouldGreetOnInbound,
} from "@/lib/agents/voice/greeting";

export const runtime = "nodejs";

const MISSED_CALL_STATUSES = new Set(["no-answer", "busy", "failed"] as const);

type MissedCallStatus = "no-answer" | "busy" | "failed";

function isMissedStatus(value: string): value is MissedCallStatus {
  return MISSED_CALL_STATUSES.has(value as MissedCallStatus);
}

async function loadTwilioCredentialsForOrg(orgId: string) {
  const [row] = await db
    .select({ integrations: organizations.integrations })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const integrations = (row?.integrations ?? {}) as Record<string, unknown>;
  const twilio = (integrations.twilio ?? {}) as {
    accountSid?: string;
    authToken?: string;
  };
  const accountSid = twilio.accountSid?.trim() ?? "";
  const raw = twilio.authToken?.trim() ?? "";

  let authToken = raw;
  if (raw.startsWith("v1.")) {
    try {
      authToken = decryptValue(raw);
    } catch {
      authToken = "";
    }
  }

  return { accountSid, authToken };
}

async function loadGreetingContext(orgId: string): Promise<{
  deployedAt: string | null;
  pausedAt: string | null;
  businessName: string | null;
}> {
  const [row] = await db
    .select({ settings: organizations.settings, soul: organizations.soul })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const agentConfigs = (settings.agentConfigs ?? {}) as Record<
    string,
    { deployedAt?: string | null; pausedAt?: string | null }
  >;
  const cfg = agentConfigs["missed-call-text-back"] ?? {};

  const soul = (row?.soul ?? {}) as Record<string, unknown>;
  const businessName =
    (typeof soul.business_name === "string" && soul.business_name.trim()) ||
    (typeof soul.businessName === "string" && soul.businessName.trim()) ||
    null;

  return {
    deployedAt: cfg.deployedAt ?? null,
    pausedAt: cfg.pausedAt ?? null,
    businessName,
  };
}

function fullRequestUrl(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (forwardedProto && forwardedHost) {
    const url = new URL(request.url);
    return `${forwardedProto}://${forwardedHost}${url.pathname}${url.search}`;
  }
  return request.url;
}

const EMPTY_TWIML_RESPONSE =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twimlResponse(xml: string) {
  return new NextResponse(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const rawText = await request.text();
  const params = new URLSearchParams(rawText);
  const body: Record<string, string> = {};
  for (const [key, value] of params) {
    body[key] = value;
  }

  const callSid = body.CallSid?.trim() ?? "";
  const callStatus = body.CallStatus?.trim() ?? "";
  const fromRaw = body.From?.trim() ?? "";
  const toRaw = body.To?.trim() ?? "";
  const direction = body.Direction?.trim() ?? "";
  const durationSeconds = Number.parseInt(body.CallDuration ?? "0", 10) || 0;

  if (!callSid) {
    return NextResponse.json({ error: "Missing CallSid" }, { status: 400 });
  }

  const fromNumber = fromRaw && fromRaw !== "anonymous" ? toE164(fromRaw) : "";
  const toNumber = toE164(toRaw);

  if (!toNumber) {
    return NextResponse.json({ error: "Missing To number" }, { status: 400 });
  }

  const orgId = await resolveWorkspaceByPhoneNumber(toNumber);
  if (!orgId) {
    logEvent("twilio_voice_webhook_no_org_match", {
      call_sid: callSid,
      to: toNumber,
      from: fromNumber,
      status: callStatus,
    });
    return callStatus && callStatus !== "ringing" && callStatus !== "in-progress"
      ? NextResponse.json({ ok: true, matched: false })
      : twimlResponse(EMPTY_TWIML_RESPONSE);
  }

  const { accountSid, authToken } = await loadTwilioCredentialsForOrg(orgId);
  if (!authToken) {
    return NextResponse.json(
      { error: "Twilio signature configuration required" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("x-twilio-signature");
  const publicRequestUrl = fullRequestUrl(request);
  let authenticated = verifyTwilioSignature({
    url: publicRequestUrl,
    body: params,
    signature,
    authToken,
  });

  // Twilio Trial's "Try out Voice" inbound interceptor can omit the normal
  // X-Twilio-Signature header when proxying a custom TwiML URL. Never accept
  // that omission on trust: staging may opt into a server-to-server fallback
  // that verifies this exact CallSid against Twilio's authenticated Calls API.
  if (
    !authenticated &&
    !signature &&
    process.env.TWILIO_TRIAL_UNSIGNED_VOICE_ENABLED === "true"
  ) {
    authenticated = await verifyUnsignedTwilioTrialVoiceRequest({
      enabled: true,
      accountSid,
      authToken,
      callSid,
      bodyAccountSid: body.AccountSid?.trim() ?? "",
      callStatus,
      direction,
      from: fromRaw,
      to: toRaw,
    });

    if (authenticated) {
      logEvent("twilio_voice_webhook_trial_rest_verified", {
        org_id: orgId,
        call_sid: callSid,
      });
    }
  }

  if (!authenticated) {
    const diagnostic = diagnoseTwilioSignature({
      url: publicRequestUrl,
      body: params,
      signature,
      authToken,
    });
    let requestPath = "unparseable";
    try {
      const parsed = new URL(publicRequestUrl);
      requestPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      // Keep a non-sensitive sentinel instead of logging raw input.
    }

    logEvent("twilio_voice_webhook_signature_rejected", {
      org_id: orgId,
      call_sid: callSid,
      signature_present: diagnostic.signaturePresent,
      signature_key_sid_present: Boolean(
        request.headers.get("x-twilio-signature-key-sid"),
      ),
      exact_path_match: diagnostic.exactPathMatch,
      toggled_trailing_slash_match: diagnostic.toggledTrailingSlashMatch,
      request_path: requestPath,
      content_type: request.headers.get("content-type") ?? "",
      forwarded_proto: request.headers.get("x-forwarded-proto") ?? "",
      forwarded_host: request.headers.get("x-forwarded-host") ?? "",
      host: request.headers.get("host") ?? "",
      parameter_names: diagnostic.parameterNames.join(","),
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const { managedMissedCall } = await import("@/lib/aurix/voice");
  const managedCall = await managedMissedCall(
    orgId,
    fromNumber,
    callSid,
    ["no-answer", "busy", "failed"].includes(callStatus),
  );
  if (managedCall) {
    return callStatus && callStatus !== "ringing" && callStatus !== "in-progress"
      ? NextResponse.json({ ok: true, handled_by: "aurix" })
      : twimlResponse(EMPTY_TWIML_RESPONSE);
  }

  const greetCtx = await loadGreetingContext(orgId);
  const greetMode = shouldGreetOnInbound(greetCtx.deployedAt, greetCtx.pausedAt);

  if (!callStatus || callStatus === "ringing" || callStatus === "in-progress") {
    if (greetMode) {
      const contactId = fromNumber
        ? await findContactByPhone(orgId, fromNumber)
        : null;
      await emitSeldonEvent(
        "call.missed",
        {
          callSid,
          contactId,
          fromNumber,
          toNumber,
          status: "no-answer",
          durationSeconds: 0,
        },
        { orgId },
      );
      logEvent("twilio_voice_webhook_greeted_and_emitted", {
        org_id: orgId,
        call_sid: callSid,
        from: fromNumber,
        to: toNumber,
        contact_id: contactId,
      });
      return twimlResponse(
        buildGreetingTwiml(buildVoiceGreeting(greetCtx.businessName)),
      );
    }

    logEvent("twilio_voice_webhook_voice_url_hit", {
      org_id: orgId,
      call_sid: callSid,
      from: fromNumber,
      to: toNumber,
    });
    return twimlResponse(EMPTY_TWIML_RESPONSE);
  }

  if (isMissedStatus(callStatus)) {
    if (greetMode) {
      logEvent("twilio_voice_webhook_missed_skipped_greeted", {
        org_id: orgId,
        call_sid: callSid,
        status: callStatus,
      });
      return NextResponse.json({ ok: true, skipped: "greeted_on_inbound" });
    }

    const contactId = fromNumber
      ? await findContactByPhone(orgId, fromNumber)
      : null;

    await emitSeldonEvent(
      "call.missed",
      {
        callSid,
        contactId,
        fromNumber,
        toNumber,
        status: callStatus,
        durationSeconds,
      },
      { orgId },
    );

    logEvent("twilio_voice_webhook_call_missed", {
      org_id: orgId,
      call_sid: callSid,
      from: fromNumber,
      to: toNumber,
      status: callStatus,
      duration: durationSeconds,
      contact_id: contactId,
    });

    return NextResponse.json({ ok: true, emitted: "call.missed" });
  }

  logEvent("twilio_voice_webhook_terminal_non_missed", {
    org_id: orgId,
    call_sid: callSid,
    status: callStatus,
    duration: durationSeconds,
  });

  return NextResponse.json({ ok: true, status: callStatus });
}
