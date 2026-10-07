import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { callMcpJson, openMcpForCurrentUser, type McpClient } from "@/lib/mcpJson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RosterTech = {
  technicianId: number;
  name: string;
  active: boolean;
  positions?: string[];
  team?: string | null;
  email?: string | null;
};

export async function GET() {
  const access = await getCurrentAccess();
  if (access?.role !== "owner") return NextResponse.json({ error: "Owners only." }, { status: 403 });

  let client: McpClient | null = null;
  try {
    client = await openMcpForCurrentUser();
    const roster = await callMcpJson<{ technicians?: RosterTech[] }>(client, "get_technician_roster", {});
    const technicians = (roster.technicians || [])
      .filter((tech) => tech.active)
      .map((tech) => ({
        technicianId: tech.technicianId,
        name: tech.name,
        positions: tech.positions || [],
        team: tech.team ? String(tech.team).trim() : null,
        email: tech.email ? String(tech.email).toLowerCase() : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ technicians }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Roster lookup failed:", error);
    return NextResponse.json({ error: "Could not load the ServiceTitan roster." }, { status: 502 });
  } finally {
    await client?.close().catch(() => undefined);
  }
}
