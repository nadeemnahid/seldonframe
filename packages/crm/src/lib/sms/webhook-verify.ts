import crypto from "node:crypto";
import { parse as parseQuery, stringify as stringifyQuery } from "node:querystring";

// Twilio signs form webhooks with HMAC-SHA1 over the exact public request URL
// followed by alphabetically sorted form parameters. Its official Node helper
// deliberately validates URL variants with and without the standard port
// because Twilio's signing backend is not fully consistent about :443/:80.
//
// In production-like deployments Seldon can sit behind a reverse proxy or
// tunnel whose internal request origin is different from the URL configured
// in Twilio. TWILIO_WEBHOOK_BASE_URL pins verification to that trusted public
// origin rather than trusting proxy-supplied host headers.
function pinnedSignatureUrl(requestUrl: string): string | null {
  const configuredBase = process.env.TWILIO_WEBHOOK_BASE_URL?.trim();
  if (!configuredBase) return requestUrl;

  try {
    const incoming = new URL(requestUrl);
    const base = new URL(configuredBase);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (base.username || base.password || base.search || base.hash) return null;

    // configuredBase is an origin-only trust anchor. Preserve the exact route
    // path/query delivered to Seldon, but never trust the incoming host.
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
  // WHATWG URL parsing strips explicit default ports, so construct this string
  // manually when no non-standard port survives parsing.
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

    // Match the official Twilio Node validation posture: with/without standard
    // port and with/without legacy query-string serialization. De-duplicate so
    // the common no-query case stays tiny.
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

// Rejection-only diagnostics. This never weakens verification and never returns
// a signature, token, URL parameter value, or request-body value. It exists so
// staging can distinguish an exact-path mismatch from a different Twilio
// signing key / trial delivery layer without logging credentials or caller PII.
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
