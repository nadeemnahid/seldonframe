import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import type { AgentTool, ToolExecuteContext } from '@/lib/agents/tools';
import { executeVoiceToolCall } from '@/lib/agents/voice/realtime-tools';
import { roofingEvidence, services, roles, timelines } from './roofing';
import { queueEvent } from './callbacks';

const schema=z.object({service_type:z.enum(services),decision_role:z.enum(roles),postal_code:z.string(),timeline:z.enum(timelines),storm_related:z.string(),insurance_status:z.string(),preferred_start:z.string(),handoff:z.enum(['yes','no']),confidence:z.enum(['high','low']),summary:z.string().max(1000)});
export async function aurixVoiceSession(ctx: ToolExecuteContext, callId: string) {
  if (!ctx.callerPhone) return null;
  const rows=await db.execute(sql`SELECT l.installation_id,l.lead_id,i.config FROM aurix_lead_links l JOIN aurix_installations i ON i.id=l.installation_id
    WHERE l.org_id=${ctx.orgId}::uuid AND l.phone=${ctx.callerPhone}`);
  if (!rows.rows.length) return null;
  const hold = { tools:[] as AgentTool[],instructions:'You are the roofing receptionist. Say a team member needs to review this enquiry and will follow up. Do not qualify, book or change customer records.',executeToolCall: async()=>({ok:false as const,error:'human_review_required'}) };
  if (rows.rows.length!==1 || process.env.AURIX_EXECUTION_ENABLED!=='true') return hold;
  const l=rows.rows[0];
  if (typeof l.installation_id!=='string'||typeof l.lead_id!=='string') return hold;
  const result=await db.execute(sql`SELECT start_aurix_voice(${l.installation_id}::uuid,${l.lead_id}::uuid,${callId}) run_id`);
  const runId=result.rows[0]?.run_id;
  if (typeof runId!=='string') return hold;
  const config=l.config;
  const zips=config&&typeof config==='object'&&'service_postal_codes' in config&&Array.isArray(config.service_postal_codes)?config.service_postal_codes.filter((x):x is string=>typeof x==='string'):[];
  const tool:AgentTool={name:'report_roofing_evidence',description:'Submit explicit roofing answers or request human handoff. Never claim a booking.',inputSchema:schema,
    jsonSchema:z.toJSONSchema(schema),
    execute:async(input)=>{
      const parsed=schema.parse(input);const evidence=roofingEvidence(parsed,runId,zips);
      await db.execute(sql`SELECT finish_aurix_qualification(${runId}::uuid,${JSON.stringify({...evidence.data,channel:'voice'})}::jsonb,${evidence.handoff})`);
      await db.execute(sql`UPDATE workflow_runs SET status='completed',updated_at=now() WHERE id=${runId}::uuid AND status='waiting'`);
      return {recorded:true,booking_confirmed:false};
    }};
  return { tools:[tool], instructions:'You are the roofing qualification assistant. Ask one question at a time: service type, owner/decision role, 5-digit ZIP, timeline, storm involvement, insurance status and preferred inspection time with timezone. Do not promise a booking. Use report_roofing_evidence to submit answers. Use unknown for missing answers. For a human request, anger, commercial complexity or insurance/legal dispute report handoff=yes and confidence=low immediately. AurixCRM determines eligibility; never invent it. Explain that a team member will confirm the inspection.',
    executeToolCall:(opts:Parameters<typeof executeVoiceToolCall>[0])=>executeVoiceToolCall({...opts,deps:{findTool:name=>name===tool.name?tool:undefined}}) };
}

export async function managedMissedCall(orgId:string,phone:string,callId:string) {
 const rows=await db.execute(sql`SELECT installation_id,lead_id FROM aurix_lead_links WHERE org_id=${orgId}::uuid AND phone=${phone}`);
 if (!rows.rows.length) return false;
 for(const l of rows.rows) if(typeof l.installation_id==='string'&&typeof l.lead_id==='string'){
  // With shared phone identity, record a handoff rather than attribute the call.
  await queueEvent(l.installation_id,l.lead_id,`call:${callId}`,rows.rows.length===1?'call.missed':'handoff.requested',
   rows.rows.length===1?{call_id:callId,phone}:{reason:'Missed call has ambiguous shared-phone identity.'});
 }
 return true;
}
