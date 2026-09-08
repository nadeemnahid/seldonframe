import { foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid, jsonb } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { contacts } from "./contacts";

export const aurixInstallations = pgTable("aurix_installations", {
  id: uuid("id").primaryKey(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  aurixOrgId: uuid("aurix_org_id").notNull(),
  status: text("status").notNull().default("draft"),
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
