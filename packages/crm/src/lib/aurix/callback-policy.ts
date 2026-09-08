import { signature } from './protocol';

/** Exact host allowlist is deployment-owned. Never follow redirects or accept arbitrary tenant URLs. */
export function callbackUrl(value: string, allowedHosts: string): string {
  const url = new URL(value);
  const allowed = allowedHosts.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
      url.pathname !== '/api/integrations/seldon/v1/events' || !allowed.includes(url.hostname.toLowerCase())) {
    throw new Error('callback_destination_not_allowed');
  }
  return url.toString();
}
export function callbackHeaders(input: { installationId: string; eventId: string; keyId: string; secret: string; rawBody: string }, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return { 'Content-Type': 'application/json', 'X-Integration-Version': '1',
    'X-Installation-Id': input.installationId, 'X-Message-Id': input.eventId,
    'X-Timestamp': timestamp, 'X-Key-Id': input.keyId,
    'X-Signature': signature(input.secret, timestamp, input.eventId, input.rawBody) };
}
export function deliveryDecision(status: number, attempts: number) {
  const transient = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
  if (!transient || attempts >= 12) return { status: 'dead' as const, delaySeconds: 0 };
  return { status: 'retry' as const, delaySeconds: Math.min(3600, 15 * 2 ** Math.min(attempts - 1, 8)) };
}
