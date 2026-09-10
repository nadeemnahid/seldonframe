// Test-only contract snapshot: nadeemnahid/aurixcrm a69be1bedee86fbe07b3c49698be11d9f329f9c1
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const SELDON_EVENT_TYPES = [
  'qualification.started',
  'qualification.completed',
  'qualification.disqualified',
  'booking.created',
  'booking.rescheduled',
  'booking.cancelled',
  'booking.completed',
  'booking.no_show',
  'handoff.requested',
  'call.missed',
  'sms.opt_out',
  'sms.opt_in',
  'workflow.failed',
] as const

export type SeldonEventType = (typeof SELDON_EVENT_TYPES)[number]

export type SeldonEventEnvelope = {
  schema_version: '1.0'
  event_id: string
  event_type: SeldonEventType
  occurred_at: string
  installation_id: string
  organization_id: string
  workspace_id: string
  lead_id: string
  contact_id: string
  correlation_id?: string | null
  data: Record<string, unknown>
}

export type RoofingQualification = {
  qualification_id: string
  workflow_run_id: string
  policy_version: 'roofing-default-v1'
  status: 'in_progress' | 'qualified' | 'disqualified'
  channel: 'sms' | 'voice' | 'mixed'
  service_type: 'roof_replacement' | 'roof_repair' | 'leak_repair' | 'storm_damage' | 'inspection' | 'maintenance' | 'other' | 'unknown'
  decision_role: 'homeowner_owner' | 'landlord_owner' | 'property_manager' | 'authorized_decision_maker' | 'tenant' | 'unknown'
  postal_code: string | null
  service_area_status: 'eligible' | 'ineligible' | 'unknown'
  timeline: 'emergency' | 'within_7_days' | 'within_30_days' | 'within_90_days' | 'over_90_days' | 'researching' | 'unknown'
  storm_related?: 'yes' | 'no' | 'unknown'
  insurance_status?: 'claim_open' | 'claim_planned' | 'not_using_insurance' | 'unknown'
  preferred_inspection_windows?: string[]
  recommended_score: number
  disqualification_reason?: 'outside_service_area' | 'unauthorized_contact' | 'unsupported_service' | 'invalid_contact' | 'spam' | 'no_service_need' | 'other' | null
  summary?: string | null
}

export type BookingEventData = {
  booking_id: string
  booking_request_id: string
  appointment_type: 'roof_inspection'
  status: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show'
  starts_at?: string
  ends_at?: string
  timezone?: string
  provider_calendar_id?: string | null
  provider_event_id?: string | null
  location?: Record<string, unknown>
  notes?: string | null
}

export type LeadIngressResponse = {
  status: 'created' | 'updated' | 'already_processed'
  lead_id: string
  contact_id: string
  workflow_run_id?: string | null
  accepted_at?: string | null
}

export class ContractValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message)
    this.name = 'ContractValidationError'
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractValidationError(field, `${field} must be an object`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, field: string, options: { uuid?: boolean; nullable?: boolean } = {}): string | null {
  if (value == null && options.nullable) return null
  if (typeof value !== 'string' || value.trim() === '') throw new ContractValidationError(field, `${field} must be a non-empty string`)
  const normalized = value.trim()
  if (options.uuid && !UUID_RE.test(normalized)) throw new ContractValidationError(field, `${field} must be a UUID`)
  return normalized
}

function enumValue<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ContractValidationError(field, `${field} contains an unsupported value`)
  }
  return value as T[number]
}

function dateTime(value: unknown, field: string, optional = false): string | undefined {
  if (value == null && optional) return undefined
  const result = stringValue(value, field)
  if (!result || Number.isNaN(Date.parse(result))) throw new ContractValidationError(field, `${field} must be an ISO date-time`)
  return result
}

export function parseSeldonEvent(value: unknown): SeldonEventEnvelope {
  const input = object(value, 'body')
  if (input.schema_version !== '1.0') throw new ContractValidationError('schema_version', 'Unsupported schema version')
  const eventType = enumValue(input.event_type, 'event_type', SELDON_EVENT_TYPES)
  return {
    schema_version: '1.0',
    event_id: stringValue(input.event_id, 'event_id')!,
    event_type: eventType,
    occurred_at: dateTime(input.occurred_at, 'occurred_at')!,
    installation_id: stringValue(input.installation_id, 'installation_id', { uuid: true })!,
    organization_id: stringValue(input.organization_id, 'organization_id', { uuid: true })!,
    workspace_id: stringValue(input.workspace_id, 'workspace_id')!,
    lead_id: stringValue(input.lead_id, 'lead_id', { uuid: true })!,
    contact_id: stringValue(input.contact_id, 'contact_id')!,
    correlation_id: input.correlation_id == null ? null : stringValue(input.correlation_id, 'correlation_id'),
    data: object(input.data, 'data'),
  }
}

const SERVICES = ['roof_replacement','roof_repair','leak_repair','storm_damage','inspection','maintenance','other','unknown'] as const
const ROLES = ['homeowner_owner','landlord_owner','property_manager','authorized_decision_maker','tenant','unknown'] as const
const TIMELINES = ['emergency','within_7_days','within_30_days','within_90_days','over_90_days','researching','unknown'] as const

export function parseRoofingQualification(value: unknown): RoofingQualification {
  const input = object(value, 'data')
  if (input.policy_version !== 'roofing-default-v1') throw new ContractValidationError('policy_version', 'Unsupported qualification policy')
  const score = Number(input.recommended_score)
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new ContractValidationError('recommended_score', 'recommended_score must be an integer from 0 to 100')
  const windows = input.preferred_inspection_windows
  if (windows != null && (!Array.isArray(windows) || windows.some((item) => typeof item !== 'string'))) {
    throw new ContractValidationError('preferred_inspection_windows', 'preferred_inspection_windows must be a string array')
  }
  return {
    qualification_id: stringValue(input.qualification_id, 'qualification_id')!,
    workflow_run_id: stringValue(input.workflow_run_id, 'workflow_run_id')!,
    policy_version: 'roofing-default-v1',
    status: enumValue(input.status, 'status', ['in_progress','qualified','disqualified'] as const),
    channel: enumValue(input.channel, 'channel', ['sms','voice','mixed'] as const),
    service_type: enumValue(input.service_type, 'service_type', SERVICES),
    decision_role: enumValue(input.decision_role, 'decision_role', ROLES),
    postal_code: stringValue(input.postal_code, 'postal_code', { nullable: true }),
    service_area_status: enumValue(input.service_area_status, 'service_area_status', ['eligible','ineligible','unknown'] as const),
    timeline: enumValue(input.timeline, 'timeline', TIMELINES),
    storm_related: input.storm_related == null ? undefined : enumValue(input.storm_related, 'storm_related', ['yes','no','unknown'] as const),
    insurance_status: input.insurance_status == null ? undefined : enumValue(input.insurance_status, 'insurance_status', ['claim_open','claim_planned','not_using_insurance','unknown'] as const),
    preferred_inspection_windows: windows as string[] | undefined,
    recommended_score: score,
    disqualification_reason: input.disqualification_reason == null ? null : enumValue(input.disqualification_reason, 'disqualification_reason', ['outside_service_area','unauthorized_contact','unsupported_service','invalid_contact','spam','no_service_need','other'] as const),
    summary: input.summary == null ? null : stringValue(input.summary, 'summary'),
  }
}

export function parseBookingEventData(value: unknown, requireSchedule: boolean): BookingEventData {
  const input = object(value, 'data')
  const status = enumValue(input.status, 'status', ['scheduled','rescheduled','cancelled','completed','no_show'] as const)
  const result: BookingEventData = {
    booking_id: stringValue(input.booking_id, 'booking_id')!,
    booking_request_id: stringValue(input.booking_request_id, 'booking_request_id')!,
    appointment_type: enumValue(input.appointment_type, 'appointment_type', ['roof_inspection'] as const),
    status,
    starts_at: dateTime(input.starts_at, 'starts_at', !requireSchedule),
    ends_at: dateTime(input.ends_at, 'ends_at', !requireSchedule),
    timezone: input.timezone == null ? undefined : stringValue(input.timezone, 'timezone')!,
    provider_calendar_id: input.provider_calendar_id == null ? null : stringValue(input.provider_calendar_id, 'provider_calendar_id'),
    provider_event_id: input.provider_event_id == null ? null : stringValue(input.provider_event_id, 'provider_event_id'),
    location: input.location == null ? undefined : object(input.location, 'location'),
    notes: input.notes == null ? null : stringValue(input.notes, 'notes'),
  }
  if (requireSchedule && (!result.starts_at || !result.ends_at || !result.timezone)) {
    throw new ContractValidationError('data', 'Scheduled booking requires starts_at, ends_at and timezone')
  }
  if (result.starts_at && result.ends_at && Date.parse(result.ends_at) <= Date.parse(result.starts_at)) {
    throw new ContractValidationError('ends_at', 'ends_at must be after starts_at')
  }
  return result
}

export function parseLeadIngressResponse(value: unknown): LeadIngressResponse {
  const input = object(value, 'response')
  const acceptedAt = input.accepted_at == null ? null : dateTime(input.accepted_at, 'accepted_at')!
  return {
    status: enumValue(input.status, 'status', ['created','updated','already_processed'] as const),
    lead_id: stringValue(input.lead_id, 'lead_id', { uuid: true })!,
    contact_id: stringValue(input.contact_id, 'contact_id')!,
    workflow_run_id: input.workflow_run_id == null ? null : stringValue(input.workflow_run_id, 'workflow_run_id'),
    accepted_at: acceptedAt,
  }
}

