import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { isFieldVoiceToolName, runFieldVoiceTool } from "@/lib/fieldVoiceTools";
import { McpToolError, openMcpForCurrentUser, type McpClient } from "@/lib/mcpJson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Runs one ServiceTitan lookup that the voice model asked for. The browser
 * relays the model's request here; identity and permissions come from the
 * signed-in session, never from the request body.
 */
export async function POST(req: Request) {
  const access = await getCurrentAccess();
  if (!access || !["owner", "sales_rep", "installer"].includes(access.role)) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const name = body?.name;
  if (!isFieldVoiceToolName(name)) {
    return NextResponse.json({ output: { error: "Unknown lookup." } });
  }

  let args: Record<string, unknown> = {};
  try {
    const raw = typeof body.arguments === "string" ? JSON.parse(body.arguments || "{}") : body.arguments;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) args = raw;
  } catch {
    args = {};
  }

  const startedAt = Date.now();
  let client: McpClient | null = null;
  try {
    client = await openMcpForCurrentUser();
    const output = await runFieldVoiceTool(
      { access, client, timeZone: access.member?.timeZone || "America/Los_Angeles" },
      name,
      args
    );
    console.info(`Field voice ${name} for ${access.email} in ${Date.now() - startedAt} ms`);
    return NextResponse.json({ output }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`Field voice ${name} failed for ${access.email}:`, error instanceof Error ? error.message : error);
    const message = error instanceof McpToolError
      ? error.message
      : "ServiceTitan could not be reached right now.";
    return NextResponse.json({ output: { error: message } });
  } finally {
    await client?.close().catch(() => undefined);
  }
}
