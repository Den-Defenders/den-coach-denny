import { NextResponse } from "next/server";
import { clearAccessCache } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import {
  isTeamRole,
  isTeamTimeZone,
  listTeamMembers,
  normalizeEmail,
  saveTeamMember,
  teamDatabaseConfigured,
  type TeamMemberInput,
} from "@/lib/teamStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

async function requireOwner() {
  const access = await getCurrentAccess();
  return access?.role === "owner" ? access : null;
}

export async function GET() {
  if (!await requireOwner()) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  if (!teamDatabaseConfigured()) {
    return NextResponse.json({ error: "Team database is not configured (set OWNER_DATABASE_URL or TEAM_DATABASE_URL)." }, { status: 500, headers: NO_STORE });
  }
  try {
    return NextResponse.json({ members: await listTeamMembers() }, { headers: NO_STORE });
  } catch (error) {
    console.error("Team list failed:", error);
    return NextResponse.json({ error: "Could not load the team list." }, { status: 500, headers: NO_STORE });
  }
}

function parseInput(body: unknown): { input?: TeamMemberInput; error?: string } {
  if (!body || typeof body !== "object") return { error: "Invalid request." };
  const raw = body as Record<string, unknown>;

  const email = typeof raw.email === "string" ? normalizeEmail(raw.email) : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };

  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName || displayName.length > 80) return { error: "Enter a name (80 characters or fewer)." };

  if (!isTeamRole(raw.role)) return { error: "Pick a role." };
  const timeZone = raw.timeZone ?? "America/Los_Angeles";
  if (!isTeamTimeZone(timeZone)) return { error: "Pick a time zone." };

  let stTechnicianId: number | null = null;
  if (raw.stTechnicianId !== null && raw.stTechnicianId !== undefined && raw.stTechnicianId !== "") {
    const id = Number(raw.stTechnicianId);
    if (!Number.isSafeInteger(id) || id <= 0) return { error: "ServiceTitan technician ID is not valid." };
    stTechnicianId = id;
  }
  if ((raw.role === "sales_rep" || raw.role === "installer") && !stTechnicianId) {
    return { error: "Sales reps and installers must be linked to their ServiceTitan technician." };
  }

  const stTechnicianName = typeof raw.stTechnicianName === "string" && raw.stTechnicianName.trim()
    ? raw.stTechnicianName.trim().slice(0, 120)
    : null;

  return {
    input: {
      email,
      displayName,
      role: raw.role,
      stTechnicianId,
      stTechnicianName: stTechnicianId ? stTechnicianName : null,
      timeZone,
      active: raw.active !== false,
    },
  };
}

export async function POST(req: Request) {
  const access = await requireOwner();
  if (!access) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  if (!teamDatabaseConfigured()) {
    return NextResponse.json({ error: "Team database is not configured." }, { status: 500, headers: NO_STORE });
  }

  const { input, error } = parseInput(await req.json().catch(() => null));
  if (!input) return NextResponse.json({ error }, { status: 400, headers: NO_STORE });

  // Do not let an owner lock themselves out from this page.
  if (access.email && input.email === access.email && (input.role !== "owner" || !input.active)) {
    return NextResponse.json({ error: "You can't remove your own owner access." }, { status: 400, headers: NO_STORE });
  }

  try {
    const member = await saveTeamMember(input, access.email || "unknown");
    clearAccessCache();
    return NextResponse.json({ member }, { headers: NO_STORE });
  } catch (saveError) {
    console.error("Team save failed:", saveError);
    return NextResponse.json({ error: "Could not save this team member." }, { status: 500, headers: NO_STORE });
  }
}
