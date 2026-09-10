-- Durable inbound SMS processing state for fast Twilio acknowledgement.
-- Existing inbound rows predate the queue and have already completed their
-- synchronous processing path, so mark them processed during the migration.
ALTER TABLE "sms_messages" ADD COLUMN "inbound_processing_status" text;
ALTER TABLE "sms_messages" ADD COLUMN "inbound_processing_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sms_messages" ADD COLUMN "inbound_processing_started_at" timestamptz;
ALTER TABLE "sms_messages" ADD COLUMN "inbound_next_attempt_at" timestamptz;
ALTER TABLE "sms_messages" ADD COLUMN "inbound_processed_at" timestamptz;
ALTER TABLE "sms_messages" ADD COLUMN "inbound_processing_error" text;
--> statement-breakpoint
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_inbound_processing_status_chk"
  CHECK ("inbound_processing_status" IS NULL OR "inbound_processing_status" IN ('pending','processing','processed','dead'));
--> statement-breakpoint
UPDATE "sms_messages"
SET "inbound_processing_status" = 'processed',
    "inbound_processed_at" = COALESCE("updated_at", "created_at")
WHERE "direction" = 'inbound'
  AND "external_message_id" IS NOT NULL
  AND "inbound_processing_status" IS NULL;
--> statement-breakpoint
-- 0080 had a narrower Aurix-only receipt index. Replace it with one provider
-- receipt identity for every SMS path so Twilio retries cannot duplicate rows.
DROP INDEX IF EXISTS "aurix_sms_receipt_uidx";
CREATE UNIQUE INDEX "sms_messages_provider_external_uidx"
  ON "sms_messages" ("provider", "external_message_id");
--> statement-breakpoint
CREATE INDEX "sms_messages_inbound_processing_idx"
  ON "sms_messages" ("direction", "inbound_processing_status", "inbound_next_attempt_at", "created_at");
