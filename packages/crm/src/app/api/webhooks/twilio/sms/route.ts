import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  organizations,
  smsEvents,
  smsMessages,
  workflowRuns,
  workflowWaits,
} from "@/db/schema";
import { decryptValue } from "@/lib/encryption";
import { emitSeldonEvent } from "@/lib/events/bus";
import { logEvent } from "@/lib/observability/log";
import { dispatchSmsAutoReply } from "@/lib/agents/channels/sms-auto-reply";
import {
  classifyInboundIntent,
  shouldAutoReplyForIntent,
} from "@/lib/messaging/classify-intent";
import { findContactByPhone, persistInboundSms } from "@/lib/sms/api";
import { toE164 } from "@/lib/sms/providers";
import {
  addPhoneSuppression,
  isHelpKeyword,
  isStopKeyword,
} from "@/lib/sms/suppression";
import { verifyTwilioSignature } from "@/lib/sms/webhook-verify";
import { dispatchTwilioInboundForMessageTriggers } from "@/lib/agents/message-trigger-wiring";
import type { OrgSoul } from "@/lib/soul/types";

export const runtime = "nodejs";

async function resolveOrgByFromNumber(fromNumber: string) {
  const rows = await db
    .select({
      id: organizations.id,
      integrations: organizations.integrations,
    })
    .from(organizations);

  for (const row of rows) {
    const integrations = (row.integrations ?? {}) as Record<string, unknown>;
    const twilio = (integrations.twilio ?? {}) as { fromNumber?: string };
    const stored = twilio.fromNumber?.trim() ?? "";
    if (stored && toE164(stored) === fromNumber) return row.id;
  }

  return null;
}

async function buildHelpReply(orgId: string): Promise<string> {
  const [row] = await db
    .select({ name: organizations.name, soul: organizations.soul })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const businessName = row?.name?.trim() || "this business";
  const soul = (row?.soul ?? null) as OrgSoul | null;
  const soulRaw = (soul ?? {}) as unknown as Record<string, unknown>;
  const businessPhone =
    typeof soulRaw.phone === "string" ? soulRaw.phone.trim() : "";

  const supportLine = businessPhone
    ? `Reach ${businessName} at ${businessPhone}.`
    : `Reach ${businessName} by replying to this thread.`;

  return `${businessName}: ${supportLine} Reply STOP to unsubscribe.`;
}

async function loadTwilioAuthTokenForOrg(orgId: string) {
  const [row] = await db
    .select({ integrations: organizations.integrations })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const integrations = (row?.integrations ?? {}) as Record<string, unknown>;
  const twilio = (integrations.twilio ?? {}) as { authToken?: string };
  const raw = twilio.authToken?.trim() ?? "";

  if (raw.startsWith("v1.")) {
    try {
      return decryptValue(raw);
    } catch {
      return "";
    }
  }
  return raw;
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

const EMPTY_MESSAGING_TWIML_RESPONSE =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function messagingTwimlResponse() {
  return new NextResponse(EMPTY_MESSAGING_TWIML_RESPONSE, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

async function handleStatusCallback(params: {
  orgId: string;
  externalMessageId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  rawBody: Record<string, string>;
}) {
  const [row] = await db
    .select()
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.orgId, params.orgId),
        eq(smsMessages.externalMessageId, params.externalMessageId),
      ),
    )
    .limit(1);

  if (!row) {
    logEvent("twilio_webhook_no_sms_match", {
      org_id: params.orgId,
      external_id: params.externalMessageId,
      status: params.status,
    });
    return { matched: false };
  }

  const providerEventId = `${params.status}:${params.externalMessageId}:${Date.now()}`;

  await db
    .insert(smsEvents)
    .values({
      orgId: params.orgId,
      smsMessageId: row.id,
      eventType: `sms.${params.status}`,
      provider: "twilio",
      providerEventId,
      payload: params.rawBody,
    })
    .onConflictDoNothing({
      target: [smsEvents.provider, smsEvents.providerEventId],
    });

  switch (params.status) {
    case "delivered":
      await db
        .update(smsMessages)
        .set({
          status: "delivered",
          deliveredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(smsMessages.id, row.id));
      await emitSeldonEvent(
        "sms.delivered",
        { smsMessageId: row.id, contactId: row.contactId },
        { orgId: params.orgId },
      );
      break;

    case "failed":
    case "undelivered":
      await db
        .update(smsMessages)
        .set({
          status: "failed",
          errorCode: params.errorCode,
          errorMessage:
            params.errorMessage ?? `Twilio reported ${params.status}`,
          updatedAt: new Date(),
        })
        .where(eq(smsMessages.id, row.id));
      await emitSeldonEvent(
        "sms.failed",
        {
          smsMessageId: row.id,
          contactId: row.contactId,
          reason: params.errorMessage ?? params.errorCode ?? params.status,
        },
        { orgId: params.orgId },
      );
      if (
        params.errorCode &&
        ["30003", "30005", "30006"].includes(params.errorCode)
      ) {
        await addPhoneSuppression({
          orgId: params.orgId,
          phone: row.toNumber,
          reason: "carrier_block",
          source: `webhook:${params.errorCode}`,
        });
      }
      break;
  }

  return { matched: true };
}

export async function POST(request: Request) {
  const rawText = await request.text();
  const params = new URLSearchParams(rawText);
  const body: Record<string, string> = {};
  for (const [key, value] of params) body[key] = value;

  const toNumber = toE164(body.To ?? "");
  const fromNumber = toE164(body.From ?? "");
  const externalMessageId = body.MessageSid ?? "";

  if (!toNumber || !externalMessageId) {
    return NextResponse.json(
      { error: "Missing required params" },
      { status: 400 },
    );
  }

  const messageStatus = body.MessageStatus?.trim() ?? "";
  const isStatusCallback = Boolean(messageStatus);

  const orgId = await resolveOrgByFromNumber(
    isStatusCallback ? fromNumber : toNumber,
  );
  if (!orgId) {
    logEvent("twilio_webhook_no_org_match", {
      status_callback: isStatusCallback,
      from: fromNumber,
      to: toNumber,
    });
    return isStatusCallback
      ? NextResponse.json({ ok: true, matched: false })
      : messagingTwimlResponse();
  }

  const authToken = await loadTwilioAuthTokenForOrg(orgId);
  if (!authToken) {
    return NextResponse.json(
      { error: "Twilio signature configuration required" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("x-twilio-signature");
  const ok = verifyTwilioSignature({
    url: fullRequestUrl(request),
    body: params,
    signature,
    authToken,
  });
  if (!ok) {
    logEvent("twilio_webhook_signature_rejected", { org_id: orgId });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (isStatusCallback) {
    const result = await handleStatusCallback({
      orgId,
      externalMessageId,
      status: messageStatus,
      errorCode: body.ErrorCode ?? null,
      errorMessage: body.ErrorMessage ?? null,
      rawBody: body,
    });
    return NextResponse.json({ ok: true, matched: result.matched });
  }

  const inboundBody = body.Body?.trim() ?? "";
  if (!inboundBody) return messagingTwimlResponse();

  const { aurixSchemaReady } = await import("@/lib/aurix/schema-ready");
  await aurixSchemaReady();

  if (isStopKeyword(inboundBody)) {
    await addPhoneSuppression({
      orgId,
      phone: fromNumber,
      reason: "stop_keyword",
      source: "webhook:stop",
    });
    await emitSeldonEvent(
      "sms.suppressed",
      { phone: fromNumber, reason: "stop_keyword", contactId: null },
      { orgId },
    );
    return messagingTwimlResponse();
  }

  if (["START", "UNSTOP"].includes(inboundBody.toUpperCase())) {
    const { verifiedOptIn } = await import("@/lib/aurix/inbound");
    try {
      const handled = await verifiedOptIn(
        orgId,
        fromNumber,
        externalMessageId,
        {
          accountSid: body.AccountSid ?? "",
          to: toNumber,
          authToken,
        },
      );
      if (handled) return messagingTwimlResponse();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (/invalid.*consent|stale_consent|invalid_provider_identity/.test(code)) {
        return messagingTwimlResponse();
      }
      return NextResponse.json(
        { error: "consent_verification_unavailable" },
        { status: 503 },
      );
    }
  }

  const { managedInbound } = await import("@/lib/aurix/inbound");
  if (
    await managedInbound({
      orgId,
      fromNumber,
      toNumber,
      body: inboundBody,
      externalMessageId,
    })
  ) {
    return messagingTwimlResponse();
  }

  if (isHelpKeyword(inboundBody)) {
    const reply = await buildHelpReply(orgId);
    const { sendSmsFromApi } = await import("@/lib/sms/api");
    await sendSmsFromApi({
      orgId,
      userId: null,
      contactId: null,
      toNumber: fromNumber,
      body: reply,
    }).catch((error) => {
      logEvent("twilio_webhook_help_send_failed", {
        org_id: orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return messagingTwimlResponse();
  }

  const contactId = await findContactByPhone(orgId, fromNumber);

  const inbound = await persistInboundSms({
    orgId,
    contactId,
    fromNumber,
    toNumber,
    body: inboundBody,
    externalMessageId,
    metadata: { twilio: body },
  });

  let conversationOwnsReply = false;
  const activeConversationWait = await db
    .select({
      id: workflowWaits.id,
      matchPredicate: workflowWaits.matchPredicate,
    })
    .from(workflowWaits)
    .innerJoin(workflowRuns, eq(workflowWaits.runId, workflowRuns.id))
    .where(
      and(
        eq(workflowRuns.orgId, orgId),
        eq(workflowWaits.eventType, "sms.replied"),
        isNull(workflowWaits.resumedAt),
        sql`(${workflowWaits.matchPredicate}->>'phone' = ${fromNumber}${
          contactId
            ? sql` OR ${workflowWaits.matchPredicate}->>'contactId' = ${contactId}`
            : sql``
        })`,
      ),
    )
    .limit(1);

  if (activeConversationWait.length > 0) {
    conversationOwnsReply = true;
    logEvent("twilio_webhook_skipped_for_conversation", {
      org_id: orgId,
      contact_id: contactId,
      from_phone: fromNumber,
      wait_id: activeConversationWait[0].id,
    });
  }

  if (!conversationOwnsReply) {
    await dispatchTwilioInboundForMessageTriggers({
      orgId,
      from: fromNumber,
      to: toNumber,
      body: inboundBody,
      externalMessageId,
      receivedAt: new Date(),
      contactId,
      conversationId: null,
    });
  }

  await emitSeldonEvent(
    "sms.replied",
    {
      smsMessageId: inbound.id,
      contactId,
      phone: fromNumber,
      conversationId: null,
    },
    { orgId },
  );

  if (contactId) {
    if (conversationOwnsReply) return messagingTwimlResponse();

    const intent = await classifyInboundIntent({ orgId, body: inboundBody });
    const autoReply = shouldAutoReplyForIntent(intent);

    logEvent("twilio_webhook_intent_classified", {
      org_id: orgId,
      contact_id: contactId,
      intent: intent ?? "unknown",
      auto_reply: autoReply,
    });

    if (autoReply) {
      const outcome = await dispatchSmsAutoReply({
        orgId,
        contactId,
        fromNumber,
        toNumber,
        inboundBody,
        smsMessageId: inbound.id,
      });
      logEvent("twilio_webhook_auto_reply", {
        org_id: orgId,
        contact_id: contactId,
        path: outcome.path,
        handled: outcome.handled,
      });
    }
  }

  return messagingTwimlResponse();
}
