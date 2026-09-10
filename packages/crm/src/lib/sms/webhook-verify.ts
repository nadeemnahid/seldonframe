import crypto from "node:crypto";
import { parse as parseQuery, stringify as stringifyQuery } from "node:querystring";

function pinnedSignatureUrl(requestUrl: string): string | null {
  const configuredBase = process.env.TWILIO_WEBHOOK_BASE_URL?.trim();
  if (!configuredBase) return requestUrl;

  try {
    const incoming = new URL(requestUrl);
    const base = new URL(configuredBase);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (base.username || base.password || base.search || base.hash) return null;
    return `${base.protocol}//${base.host}${incoming.pathname}${incoming.search}`;
  } catch {
    return null;
  }
}

function expectedSignature(authToken: string, url: string, body: URLSearchParams) {
  const keys = [...new Set(body.keys())].sort();
  let signed = url;

  for (const key of keys) {
    const values = [...new Set(body.getAll(key))].sort();
    for (const value of values) signed += key + value;
  }

  return crypto.createHmac("sha1", authToken).update(Buffer.from(signed, "utf-8")).digest("base64");
}

function signaturesEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function removePort(url: URL) {
  const copy = new URL(url);
  copy.port = "";
  return copy.toString();
}

function addStandardPort(url: URL) {
  if (url.port) return url.toString();
  const port = url.protocol === "https:" ? ":443" : ":80";
  return `${url.protocol}//${url.hostname}${port}${url.pathname}${url.search}${url.hash}`;
}

function withLegacyQuerystring(url: string) {
  const parsed = new URL(url);
  if (!parsed.search) return url;

  const query = parseQuery(parsed.search.slice(1));
  parsed.search = "";
  return `${parsed.toString()}?${stringifyQuery(query)}`;
}

function candidateSignatureUrls(requestUrl: string): string[] {
  const pinned = pinnedSignatureUrl(requestUrl);
  if (!pinned) return [];

  try {
    const parsed = new URL(pinned);
    const withoutPort = removePort(parsed);
    const withPort = addStandardPort(parsed);
    return [...new Set([
      withoutPort,
      withPort,
      withLegacyQuerystring(withoutPort),
      withLegacyQuerystring(withPort),
    ])];
  } catch {
    return [];
  }
}

function anyCandidateMatches(params: {
  url: string;
  body: URLSearchParams;
  signature: string;
  authToken: string;
}) {
  for (const url of candidateSignatureUrls(params.url)) {
    const expected = expectedSignature(params.authToken, url, params.body);
    if (signaturesEqual(params.signature, expected)) return true;
  }
  return false;
}

export function verifyTwilioSignature(params: {
  url: string;
  body: URLSearchParams;
  signature: string | null;
  authToken: string;
}) {
  if (!params.signature || !params.authToken) return false;
  return anyCandidateMatches({
    url: params.url,
    body: params.body,
    signature: params.signature,
    authToken: params.authToken,
  });
}

// Twilio Trial's "Try out Voice" inbound interceptor can fetch custom TwiML
// without forwarding X-Twilio-Signature. This fallback is deliberately
// separate from normal signature validation and must be explicitly enabled by
// the caller (staging only). It authenticates the exact CallSid server-to-
// server against Twilio's REST API and is limited to the initial inbound
// ringing fetch; unsigned terminal callbacks remain fail-closed.
export async function verifyUnsignedTwilioTrialVoiceRequest(params: {
  enabled: boolean;
  accountSid: string;
  authToken: string;
  callSid: string;
  bodyAccountSid: string;
  callStatus: string;
  direction: string;
  from: string;
  to: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}) {
  if (!params.enabled) return false;
  if (params.callStatus !== "ringing" || params.direction !== "inbound") return false;
  if (!/^AC[0-9A-Fa-f]{32}$/.test(params.accountSid)) return false;
  if (!/^CA[0-9A-Fa-f]{32}$/.test(params.callSid)) return false;
  if (!params.authToken || params.bodyAccountSid !== params.accountSid) return false;

  const fetchImpl = params.fetchImpl ?? fetch;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Calls/${encodeURIComponent(params.callSid)}.json`;
  const authorization = Buffer.from(`${params.accountSid}:${params.authToken}`, "utf-8").toString("base64");

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${authorization}`,
        Accept: "application/json",
      },
      cache: "no-store",
      // Trial custom TwiML has a hard 5-second fetch deadline. Fail closed
      // before that deadline rather than allowing a slow REST lookup to make
      // Twilio time out while waiting for TwiML.
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;

    const call = (await response.json()) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    if (text(call.sid) !== params.callSid) return false;
    if (text(call.account_sid) !== params.accountSid) return false;
    if (text(call.direction) !== "inbound") return false;
    if (text(call.from) !== params.from.trim()) return false;
    if (text(call.to) !== params.to.trim()) return false;

    const createdAt = Date.parse(text(call.date_created));
    if (!Number.isFinite(createdAt)) return false;
    const now = (params.now ?? new Date()).getTime();
    const ageMs = now - createdAt;
    if (ageMs < -60_000 || ageMs > 10 * 60_000) return false;

    return true;
  } catch {
    return false;
  }
}

export function diagnoseTwilioSignature(params: {
  url: string;
  body: URLSearchParams;
  signature: string | null;
  authToken: string;
}) {
  if (!params.signature || !params.authToken) {
    return {
      signaturePresent: Boolean(params.signature),
      exactPathMatch: false,
      toggledTrailingSlashMatch: false,
      parameterNames: [...new Set(params.body.keys())].sort(),
    };
  }

  const exactPathMatch = anyCandidateMatches({
    url: params.url,
    body: params.body,
    signature: params.signature,
    authToken: params.authToken,
  });

  let toggledTrailingSlashMatch = false;
  try {
    const u = new URL(params.url);
    if (u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1) || "/";
    } else {
      u.pathname += "/";
    }
    toggledTrailingSlashMatch = anyCandidateMatches({
      url: u.toString(),
      body: params.body,
      signature: params.signature,
      authToken: params.authToken,
    });
  } catch {
    // Keep fail-closed diagnostic defaults.
  }

  return {
    signaturePresent: true,
    exactPathMatch,
    toggledTrailingSlashMatch,
    parameterNames: [...new Set(params.body.keys())].sort(),
  };
}
