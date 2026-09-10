// Test-only contract snapshot: nadeemnahid/aurixcrm a69be1bedee86fbe07b3c49698be11d9f329f9c1
import type { RoofingQualification } from './contracts'

const SUPPORTED_SERVICES = new Set<RoofingQualification['service_type']>([
  'roof_replacement','roof_repair','leak_repair','storm_damage','inspection',
])
const AUTHORIZED_ROLES = new Set<RoofingQualification['decision_role']>([
  'homeowner_owner','landlord_owner','property_manager','authorized_decision_maker',
])
const QUALIFYING_TIMELINES = new Set<RoofingQualification['timeline']>([
  'emergency','within_7_days','within_30_days','within_90_days',
])

export type CanonicalQualification = {
  qualified: boolean
  canonicalScore: number
  reasons: string[]
}

/**
 * roofing-default-v1 score (frozen):
 * supported service 25 + authorized decision role 20 + postal code 10 +
 * eligible service area 20 + timeline (emergency/7d 25, 30d 10, 90d 5).
 */
export function evaluateRoofingQualification(input: RoofingQualification): CanonicalQualification {
  let score = 0
  const reasons: string[] = []

  if (SUPPORTED_SERVICES.has(input.service_type)) score += 25
  else reasons.push('unsupported_service')

  if (AUTHORIZED_ROLES.has(input.decision_role)) score += 20
  else reasons.push('unauthorized_decision_role')

  if (input.postal_code?.trim()) score += 10
  else reasons.push('missing_postal_code')

  if (input.service_area_status === 'eligible') score += 20
  else reasons.push('outside_or_unknown_service_area')

  if (input.timeline === 'emergency' || input.timeline === 'within_7_days') score += 25
  else if (input.timeline === 'within_30_days') score += 10
  else if (input.timeline === 'within_90_days') score += 5
  else reasons.push('non_qualifying_timeline')

  const qualified =
    input.status === 'qualified' &&
    SUPPORTED_SERVICES.has(input.service_type) &&
    AUTHORIZED_ROLES.has(input.decision_role) &&
    Boolean(input.postal_code?.trim()) &&
    input.service_area_status === 'eligible' &&
    QUALIFYING_TIMELINES.has(input.timeline)

  if (input.status !== 'qualified') reasons.unshift(`reported_status_${input.status}`)
  return { qualified, canonicalScore: Math.min(100, score), reasons }
}

