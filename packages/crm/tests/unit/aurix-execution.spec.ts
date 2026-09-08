import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackHeaders, callbackUrl, deliveryDecision } from '../../src/lib/aurix/callback-policy';
import { parseHeaders, verify } from '../../src/lib/aurix/protocol';
import { roofingEvidence, roofingSpec } from '../../src/lib/aurix/roofing';
import { AgentSpecSchema } from '../../src/lib/agents/validator';

test('callback retry keeps exact bytes and identity with refreshed timestamp',()=>{
 const input={installationId:'00000000-0000-4000-8000-000000000001',eventId:'event-1',keyId:'outbound',secret:'a'.repeat(32),rawBody:'{ "b": 2, "a": 1 }'};
 for(const now of [1788879600000,1788880200000]) verify(parseHeaders(new Headers(callbackHeaders(input,now)),now),input.rawBody,input.secret);
 assert.throws(()=>verify(parseHeaders(new Headers(callbackHeaders(input,1788879600000)),1788879600000),'{"a":1,"b":2}',input.secret));
});
test('callback URLs require exact deployment allowlist and refuse redirect-shaped URLs',()=>{
 assert.equal(callbackUrl('https://crm.example.com/api/integrations/seldon/v1/events','crm.example.com'),'https://crm.example.com/api/integrations/seldon/v1/events');
 for(const url of ['http://crm.example.com/api/integrations/seldon/v1/events','https://crm.example.com.evil.test/api/integrations/seldon/v1/events','https://user@crm.example.com/api/integrations/seldon/v1/events','https://crm.example.com/api/integrations/seldon/v1/events?q=1']) assert.throws(()=>callbackUrl(url,'crm.example.com'));
});
test('transport failures have one bounded retry schedule; terminal errors stop',()=>{
 for(const status of [0,408,425,429,500,503]) assert.equal(deliveryDecision(status,1).status,'retry');
 for(const status of [400,401,403,404,409,422]) assert.equal(deliveryDecision(status,1).status,'dead');
 assert.equal(deliveryDecision(503,12).status,'dead');
 assert.equal(deliveryDecision(503,11).delaySeconds,3600);
});
const input={service_type:'roof_replacement',decision_role:'homeowner_owner',postal_code:'75230',timeline:'within_30_days',confidence:'high',handoff:'no'};
test('roofing reports evidence, derives ZIP eligibility from configuration and defers canonical score',()=>{
 const r=roofingEvidence(input,'run-1',['75230']);
 assert.equal(r.handoff,false);assert.equal(r.data.status,'qualified');assert.equal(r.data.recommended_score,0);
 assert.equal(roofingEvidence({...input,service_area_status:'eligible'},'run-1',['90210']).data.status,'disqualified');
 assert.equal(roofingEvidence({...input,decision_role:'tenant'},'run-1',['75230']).data.status,'disqualified');
});
test('uncertainty and explicit escalation force human review',()=>{
 for(const patch of [{confidence:'low'},{handoff:'yes'},{postal_code:'unknown'},{service_type:'{{service_type}}'}]) assert.equal(roofingEvidence({...input,...patch},'run-1',['75230']).handoff,true);
});
test('roofing spec uses native conversation and reports before any booking',()=>{
 assert.equal(AgentSpecSchema.safeParse(roofingSpec()).success,true);
 assert.equal(roofingSpec().steps.some(s=>s.type==='mcp_tool_call'&&s.tool==='create_booking'),false);
});

import { parseRoofingQualification, parseSeldonEvent } from '../fixtures/aurix/contracts';
import { evaluateRoofingQualification } from '../fixtures/aurix/qualification-policy';
test('Seldon evidence passes the pinned Aurix parser and yields canonical score 85',()=>{
 const data=parseRoofingQualification(roofingEvidence(input,'run-1',['75230']).data);
 assert.deepEqual(evaluateRoofingQualification(data),{qualified:true,canonicalScore:85,reasons:[]});
 assert.equal(evaluateRoofingQualification({...data,service_area_status:'ineligible'}).qualified,false);
 const event=parseSeldonEvent({schema_version:'1.0',event_id:'event-1',event_type:'qualification.completed',occurred_at:new Date().toISOString(),
  installation_id:'00000000-0000-4000-8000-000000000001',organization_id:'00000000-0000-4000-8000-000000000002',workspace_id:'workspace',lead_id:'00000000-0000-4000-8000-000000000003',contact_id:'contact',data});
 assert.equal(event.data.workflow_run_id,'run-1');
});
