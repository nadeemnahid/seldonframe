import crypto from "node:crypto";

// Twilio signs form webhooks with HMAC-SHA1 over the exact public request URL
// followed by the alphabetically sorted form parameters. When a parameter
// appears more than once, Twilio's Node validator sorts/deduplicates its
// values before appending them.
//
// In production-like deployments Seldon can sit behind a reverse proxy or
// tunnel whose internal request origin is different from the URL configured
// in Twilio. TWILIO_WEBHOOK_BASE_URL pins signature verification to that
// trusted public origin instead of trusting proxy-supplied host headers.
function signatureUrl(requestUrl: string): string | null {
  const configuredBase = process.env.TWILIO_WEBHOOK_BASE_URL?.trim();
  if (!configuredBase) return requestUrl;

  try {
    const incoming = new URL(requestUrl);
    const base = new URL(configuredBase);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (base.username || base.password || base.search || base.hash) return null;

    return `${base.origin}${incoming.pathname}${incoming.search}`;
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

  return crypto.createHmac("sha1", authToken).update(signed).digest("base64");
}

export function verifyTwilioSignature(params: {
  url: string;
  body: URLSearchParams;
  signature: string | null;
  authToken: string;
}) {
  if (!params.signature || !params.authToken) return false;

  const url = signatureUrl(params.url);
  if (!url) return false;

  const expected = expectedSignature(params.authToken, url, params.body);
  const actualBuffer = Buffer.from(params.signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
