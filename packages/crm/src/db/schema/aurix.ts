import { foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid, jsonb, bigint, integer } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { workflowRuns } from "./workflow-runs";
import { bookings } from "./bookings";
import { contacts } from "./contacts";

export const aurixInstallations = pgTable("aurix_installations", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  aurixOrgId: uuid("aurix_org_id").notNull(),
  status: text("status").notNull().default("draft"),
  callbackUrl: text("callback_url"), config: jsonb("config").notNull().default({}), qaEvidence: jsonb("qa_evidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.id, t.orgId)]).enableRLS();

export const aurixKeys = pgTable("aurix_keys", {
  installationId: uuid("installation_id").notNull().references(() => aurixInstallations.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(), direction: text("direction").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(), status: text("status").notNull().default("active"),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
}, t => [primaryKey({ columns: [t.installationId, t.direction, t.keyId] })]).enableRLS();

export const aurixLeadLinks = pgTable("aurix_lead_links", {
  installationId: uuid("installation_id").notNull(), orgId: uuid("org_id").notNull(), leadId: uuid("lead_id").notNull(),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  phone: text("phone").notNull(), sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
  context: jsonb("context").$type<Record<string, unknown>>().notNull(),
  workflowState: text("workflow_state").notNull().default("hold_for_qa"),
  workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {onDelete:"restrict"}),
  consentOverride: jsonb("consent_override"), executionLeaseUntil: timestamp("execution_lease_until",{withTimezone:true}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.installationId,t.leadId] }), unique().on(t.installationId,t.contactId),
  foreignKey({ columns: [t.installationId,t.orgId], foreignColumns: [aurixInstallations.id,aurixInstallations.orgId] }).onDelete("restrict"),
  index("aurix_links_phone_idx").on(t.orgId,t.phone)]).enableRLS();

export const aurixInbox = pgTable("aurix_inbox", {
  installationId: uuid("installation_id").notNull().references(() => aurixInstallations.id, { onDelete: "restrict" }),
  messageId: text("message_id").notNull(), bodyHash: text("body_hash").notNull(), rawBody: text("raw_body").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.installationId,t.messageId] })]).enableRLS();

export const aurixCallbackOutbox = pgTable("aurix_callback_outbox", {
  id: bigint("id",{mode:"number"}).primaryKey().generatedAlwaysAsIdentity(),
  installationId: uuid("installation_id").notNull().references(()=>aurixInstallations.id,{onDelete:"restrict"}),
  leadId: uuid("lead_id").notNull(),eventId:text("event_id").notNull(),eventType:text("event_type").notNull(),sourceKey:text("source_key").notNull(),
  rawBody:text("raw_body").notNull(),status:text("status").notNull().default("pending"),attempts:integer("attempts").notNull().default(0),
  availableAt:timestamp("available_at",{withTimezone:true}).notNull().defaultNow(),leaseToken:uuid("lease_token"),leaseUntil:timestamp("lease_until",{withTimezone:true}),
  lastError:text("last_error"),acknowledgedResult:jsonb("acknowledged_result"),deliveredAt:timestamp("delivered_at",{withTimezone:true}),
  createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[unique().on(t.installationId,t.sourceKey),unique().on(t.installationId,t.eventId),
 foreignKey({columns:[t.installationId,t.leadId],foreignColumns:[aurixLeadLinks.installationId,aurixLeadLinks.leadId]}).onDelete("restrict"),
 index("aurix_callback_due_idx").on(t.status,t.availableAt)]).enableRLS();
export const aurixBookingLinks=pgTable("aurix_booking_links",{
 bookingId:uuid("booking_id").primaryKey().references(()=>bookings.id,{onDelete:"restrict"}),installationId:uuid("installation_id").notNull(),leadId:uuid("lead_id").notNull(),
 requestId:text("request_id").notNull(),revision:integer("revision").notNull().default(0),
},t=>[unique().on(t.installationId,t.requestId),foreignKey({columns:[t.installationId,t.leadId],foreignColumns:[aurixLeadLinks.installationId,aurixLeadLinks.leadId]}).onDelete("restrict")]).enableRLS();
export const aurixConsentReceipts=pgTable("aurix_consent_receipts",{
 orgId:uuid("org_id").notNull().references(()=>organizations.id),receiptId:text("receipt_id").notNull(),phone:text("phone").notNull(),evidence:jsonb("evidence").notNull(),
 createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.orgId,t.receiptId]})]).enableRLS();
