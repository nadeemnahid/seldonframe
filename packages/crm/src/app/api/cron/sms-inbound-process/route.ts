import { NextResponse } from "next/server";

import { tickInboundSmsProcessing } from "@/lib/sms/inbound-processing";

export const runtime = "nodejs";

function isAuthorized(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) return true;
  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${configuredSecret}`) return true;
  return request.headers.get("x-cron-secret") === configuredSecret;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await tickInboundSmsProcessing();
    return NextResponse.json({ ok: true, ...stats });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
