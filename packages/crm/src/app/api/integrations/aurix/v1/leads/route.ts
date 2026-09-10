import { handleLead } from "@/lib/aurix/ingress";
import { ingressStore } from "@/lib/aurix/store";

export const runtime = "nodejs";

// Machine-to-machine HMAC endpoint, not a workspace Bearer/session endpoint.
export async function POST(request: Request) {
  if (process.env.AURIX_INGRESS_ENABLED !== "true") {
    return Response.json({ error: "aurix_ingress_disabled" }, { status: 503 });
  }
  return handleLead(request, ingressStore);
}
