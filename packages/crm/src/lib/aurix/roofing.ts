import type { AgentSpec } from '@/lib/agents/validator';

export const services = ['roof_replacement','roof_repair','leak_repair','storm_damage','inspection','maintenance','other','unknown'] as const;
export const roles = ['homeowner_owner','landlord_owner','property_manager','authorized_decision_maker','tenant','unknown'] as const;
export const timelines = ['emergency','within_7_days','within_30_days','within_90_days','over_90_days','researching','unknown'] as const;
function choice(value: unknown, choices: readonly string[]) { return typeof value === 'string' && choices.includes(value) ? value : 'unknown'; }
export function roofingEvidence(input: Record<string, unknown>, runId: string, zips: string[]) {
  const service = choice(input.service_type, services), role = choice(input.decision_role, roles), timeline = choice(input.timeline, timelines);
  const zip = typeof input.postal_code === 'string' && /^\d{5}$/.test(input.postal_code.trim()) ? input.postal_code.trim() : null;
  const area = !zip || !zips.length ? 'unknown' : zips.includes(zip) ? 'eligible' : 'ineligible';
  const supported = services.slice(0,5).includes(service as typeof services[0]);
  const authorized = roles.slice(0,4).includes(role as typeof roles[0]);
  const timely = ['emergency','within_7_days','within_30_days','within_90_days'].includes(timeline);
  const qualified = supported && authorized && area === 'eligible' && timely;
  const incomplete = service === 'unknown' || role === 'unknown' || timeline === 'unknown' || area === 'unknown';
  const handoff = input.handoff === 'yes' || input.handoff === true || input.confidence !== 'high' || incomplete;
  return { handoff, data: { qualification_id: runId, workflow_run_id: runId, policy_version: 'roofing-default-v1',
    status: qualified ? 'qualified' : 'disqualified', channel: 'sms', service_type: service, decision_role: role,
    postal_code: zip, service_area_status: area, timeline,
    storm_related: choice(input.storm_related,['yes','no','unknown']),
    insurance_status: choice(input.insurance_status,['claim_open','claim_planned','not_using_insurance','unknown']),
    preferred_inspection_windows: typeof input.preferred_start === 'string' && input.preferred_start !== 'unknown' ? [input.preferred_start] : [],
    recommended_score: 0, // Aurix calculates independently; no competing scoring authority.
    summary: typeof input.summary === 'string' ? input.summary.slice(0,1000) : 'Roofing qualification evidence',
  }};
}
export function roofingSpec(): AgentSpec {
  const extract = { service_type: services.join(' | '), decision_role: roles.join(' | '), postal_code: '5-digit ZIP or unknown',
    timeline: timelines.join(' | '), storm_related: 'yes | no | unknown',
    insurance_status: 'claim_open | claim_planned | not_using_insurance | unknown',
    preferred_start: 'Customer explicitly selected inspection start, ISO datetime with timezone offset, or unknown. Never invent a slot.',
    handoff: 'yes if person requested, anger, commercial complexity, legal/insurance dispute; otherwise no',
    confidence: 'high only when each answer is explicit and unambiguous; otherwise low', summary: 'Concise factual summary' };
  return { name: 'Aurix roofing qualification', description: 'Collect structured roofing evidence; Aurix owns qualification and conversions.',
    trigger: { type: 'event', event: 'lead.created' }, steps: [
      { id: 'qualify', type: 'conversation', channel: 'sms',
        initial_message: 'Hi {{contact.firstName}}, thanks for your roofing enquiry. What roofing work do you need? Reply STOP to opt out.',
        exit_when: 'Collect service type, decision role, ZIP, timeline, storm involvement, insurance status, preferred inspection window. Do not promise a booking. Immediately exit with handoff=yes for a human request, complaint, legal/insurance dispute or complex commercial job. Unknown facts must stay unknown.',
        on_exit: { extract, next: 'report' } },
      { id: 'report', type: 'mcp_tool_call', tool: 'aurix_report_roofing',
        args: Object.fromEntries(Object.keys(extract).map(k => [k,`{{${k}}}`])), next: null },
    ] };
}
