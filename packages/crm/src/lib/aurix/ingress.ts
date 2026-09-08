import { AurixError, hash, parseHeaders, parseLead, readBody, verify } from "./protocol";

export type IngressStore = {
  getInboundSecret(installationId: string, keyId: string): Promise<string | null>;
  accept(input: ReturnType<typeof parseLead> & { installationId: string; messageId: string; bodyHash: string; rawBody: string }): Promise<unknown>;
};

export async function handleLead(request: Request, store: IngressStore): Promise<Response> {
  try {
    // Reject malformed and stale requests before database work.
    const headers = parseHeaders(request.headers);
    const body = await readBody(request);
    const secret = await store.getInboundSecret(headers.installationId, headers.keyId);
    if (!secret) throw new AurixError("installation_or_key_unavailable", 401);
    verify(headers, body, secret);
    const lead = parseLead(body, headers.installationId);
    const result = await store.accept({ ...lead, installationId: headers.installationId,
      messageId: headers.messageId, bodyHash: hash(body), rawBody: body });
    return Response.json(result);
  } catch (error) {
    const problem = error instanceof AurixError ? error : new AurixError("dependency_unavailable", 503);
    return Response.json({ type: `urn:aurix:${problem.code}`, title: problem.code, status: problem.status },
      { status: problem.status, headers: { "Content-Type": "application/problem+json" } });
  }
}
