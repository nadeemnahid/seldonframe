/** Verify Twilio's original message record, not just webhook arrival time.
 * https://www.twilio.com/docs/messaging/api/message-resource#fetch-a-message-resource
 */
export function consentFromProvider(value: unknown, expected: {accountSid:string;messageId:string;from:string;to:string}, now=Date.now()) {
  if (!value || typeof value!=='object') throw new Error('invalid_consent_message');
  const m=value as Record<string,unknown>;
  const captured=typeof m.date_created==='string'?Date.parse(m.date_created):NaN;
  if(m.sid!==expected.messageId || m.account_sid!==expected.accountSid || m.from!==expected.from || m.to!==expected.to ||
     m.direction!=='inbound' || typeof m.body!=='string' || !['START','UNSTOP'].includes(m.body.trim().toUpperCase()) ||
     !Number.isFinite(captured) || captured>now || now-captured>300000) throw new Error('invalid_or_stale_consent_message');
  return {status:'allowed',explicit:true,captured_at:new Date(captured).toISOString(),source:'twilio_verified_start'};
}
export async function fetchConsentEvidence(input:{accountSid:string;messageId:string;from:string;to:string;authToken:string}) {
  if(!/^AC[0-9a-f]{32}$/i.test(input.accountSid)||!/^SM[0-9a-f]{32}$/i.test(input.messageId)) throw new Error('invalid_provider_identity');
  const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${input.accountSid}/Messages/${input.messageId}.json`,{
    headers:{Authorization:`Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString('base64')}`},
    redirect:'error',signal:AbortSignal.timeout(10000),
  });
  if(!response.ok) throw new Error('consent_provider_unavailable');
  return consentFromProvider(await response.json(),input);
}
