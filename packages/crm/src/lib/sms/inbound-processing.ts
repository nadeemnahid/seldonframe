import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { smsMessages, workflowRuns, workflowWaits } from "@/db/schema";
import { dispatchSmsAutoReply } from "@/lib/agents/channels/sms-auto-reply";
import { dispatchTwilioInboundForMessageTriggers } from "@/lib/agents/message-trigger-wiring";
import { emitSeldonEvent } from "@/lib/events/bus";
import {
  classifyInboundIntent,
  shouldAutoReplyForIntent,
} from "@/lib/messaging/classify-intent";
import { logEvent } from "@/lib/observability/log";
import { findContactByPhone } from "@/lib/sms/api";

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const BATCH_SIZE = 20;

export type InboundProcessingResult =
  | { claimed: false; processed: false }
  | { claimed: true; processed: true }
  | { claimed: true; processed: false; dead: boolean };

export function inboundRetryDelayMs(attempt: number) {
  const safeAttempt = Math.max(1, Math.min(attempt, MAX_ATTEMPTS));
  return Math.min(15 * 60_000, 30_000 * 2 ** (safeAttempt - 1));
}

async function claimInboundSms(id: string) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);

  const [row] = await db
    .update(smsMessages)
    .set({
      inboundProcessingStatus: "processing",
      inboundProcessingAttempts: sql`${smsMessages.inboundProcessingAttempts} + 1`,
      inboundProcessingStartedAt: now,
      inboundNextAttemptAt: null,
      inboundProcessingError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(smsMessages.id, id),
        eq(smsMessages.provider, "twilio"),
        eq(smsMessages.direction, "inbound"),
        or(
          and(
            eq(smsMessages.inboundProcessingStatus, "pending"),
            or(
              isNull(smsMessages.inboundNextAttemptAt),
              lte(smsMessages.inboundNextAttemptAt, now),
            ),
          ),
          and(
            eq(smsMessages.inboundProcessingStatus, "processing"),
            lte(smsMessages.inboundProcessingStartedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({
      id: smsMessages.id,
      orgId: smsMessages.orgId,
      contactId: smsMessages.contactId,
      fromNumber: smsMessages.fromNumber,
      toNumber: smsMessages.toNumber,
      body: smsMessages.body,
      externalMessageId: smsMessages.externalMessageId,
      attempts: smsMessages.inboundProcessingAttempts,
      createdAt: smsMessages.createdAt,
    });

  return row ?? null;
}

async function markProcessed(id: string) {
  const now = new Date();
  await db
    .update(smsMessages)
    .set({
      inboundProcessingStatus: "processed",
      inboundProcessingStartedAt: null,
      inboundNextAttemptAt: null,
      inboundProcessedAt: now,
      inboundProcessingError: null,
      updatedAt: now,
    })
    .where(eq(smsMessages.id, id));
}

async function markRetryOrDead(id: string, attempts: number, error: unknown) {
  const dead = attempts >= MAX_ATTEMPTS;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const now = new Date();
  await db
    .update(smsMessages)
    .set({
      inboundProcessingStatus: dead ? "dead" : "pending",
      inboundProcessingStartedAt: null,
      inboundNextAttemptAt: dead
        ? null
        : new Date(now.getTime() + inboundRetryDelayMs(attempts)),
      inboundProcessingError: message,
      updatedAt: now,
    })
    .where(eq(smsMessages.id, id));

  logEvent(dead ? "twilio_inbound_processing_dead" : "twilio_inbound_processing_retry", {
    sms_message_id: id,
    attempts,
    error: message,
  });

  return dead;
}

export async function processInboundSmsById(id: string): Promise<InboundProcessingResult> {
  const row = await claimInboundSms(id);
  if (!row) return { claimed: false, processed: false };

  if (!row.externalMessageId) {
    const dead = await markRetryOrDead(row.id, MAX_ATTEMPTS, "missing_external_message_id");
    return { claimed: true, processed: false, dead };
  }

  try {
    const { managedInbound } = await import("@/lib/aurix/inbound");
    const managed = await managedInbound({
      orgId: row.orgId,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      body: row.body,
      externalMessageId: row.externalMessageId,
      persistedMessageId: row.id,
    });

    if (managed) {
      await markProcessed(row.id);
      return { claimed: true, processed: true };
    }

    const contactId = await findContactByPhone(row.orgId, row.fromNumber);
    if (contactId !== row.contactId) {
      await db
        .update(smsMessages)
        .set({ contactId, updatedAt: new Date() })
        .where(eq(smsMessages.id, row.id));
    }

    let conversationOwnsReply = false;
    const activeConversationWait = await db
      .select({ id: workflowWaits.id })
      .from(workflowWaits)
      .innerJoin(workflowRuns, eq(workflowWaits.runId, workflowRuns.id))
      .where(
        and(
          eq(workflowRuns.orgId, row.orgId),
          eq(workflowWaits.eventType, "sms.replied"),
          isNull(workflowWaits.resumedAt),
          sql`(${workflowWaits.matchPredicate}->>'phone' = ${row.fromNumber}${
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
        org_id: row.orgId,
        contact_id: contactId,
        wait_id: activeConversationWait[0].id,
      });
    }

    if (!conversationOwnsReply) {
      await dispatchTwilioInboundForMessageTriggers({
        orgId: row.orgId,
        from: row.fromNumber,
        to: row.toNumber,
        body: row.body,
        externalMessageId: row.externalMessageId,
        receivedAt: row.createdAt,
        contactId,
        conversationId: null,
      });
    }

    await emitSeldonEvent(
      "sms.replied",
      {
        smsMessageId: row.id,
        contactId,
        phone: row.fromNumber,
        conversationId: null,
      },
      { orgId: row.orgId },
    );

    if (contactId && !conversationOwnsReply) {
      const intent = await classifyInboundIntent({ orgId: row.orgId, body: row.body });
      const autoReply = shouldAutoReplyForIntent(intent);

      logEvent("twilio_webhook_intent_classified", {
        org_id: row.orgId,
        contact_id: contactId,
        intent: intent ?? "unknown",
        auto_reply: autoReply,
      });

      if (autoReply) {
        const outcome = await dispatchSmsAutoReply({
          orgId: row.orgId,
          contactId,
          fromNumber: row.fromNumber,
          toNumber: row.toNumber,
          inboundBody: row.body,
          smsMessageId: row.id,
        });
        logEvent("twilio_webhook_auto_reply", {
          org_id: row.orgId,
          contact_id: contactId,
          path: outcome.path,
          handled: outcome.handled,
        });
      }
    }

    await markProcessed(row.id);
    return { claimed: true, processed: true };
  } catch (error) {
    const dead = await markRetryOrDead(row.id, row.attempts, error);
    return { claimed: true, processed: false, dead };
  }
}

export async function tickInboundSmsProcessing(limit = BATCH_SIZE) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const rows = await db
    .select({ id: smsMessages.id })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.provider, "twilio"),
        eq(smsMessages.direction, "inbound"),
        or(
          and(
            eq(smsMessages.inboundProcessingStatus, "pending"),
            or(
              isNull(smsMessages.inboundNextAttemptAt),
              lte(smsMessages.inboundNextAttemptAt, now),
            ),
          ),
          and(
            eq(smsMessages.inboundProcessingStatus, "processing"),
            lte(smsMessages.inboundProcessingStartedAt, staleBefore),
          ),
        ),
      ),
    )
    .orderBy(smsMessages.createdAt)
    .limit(Math.max(1, Math.min(limit, 100)));

  let processed = 0;
  let retried = 0;
  let dead = 0;
  for (const candidate of rows) {
    const result = await processInboundSmsById(candidate.id);
    if (!result.claimed) continue;
    if (result.processed) processed++;
    else if (result.dead) dead++;
    else retried++;
  }

  return { candidates: rows.length, processed, retried, dead };
}
