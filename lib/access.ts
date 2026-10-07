/**
 * lib/access.ts
 *
 * One place that decides what a signed-in Den Coach Denny user may see.
 *
 *   owner      - everything, plus the Team page and the Owner Dashboard
 *   csr        - Home, Chat, Let Denny Listen, Smart Scheduler (today's CSR app)
 *   sales_rep  - Home, Smart Scheduler, Talk with Denny (voice)
 *   installer  - Home, Smart Scheduler, Talk with Denny (voice)
 *
 * Roles come from the Neon table den_team_members (managed on the /team page).
 * The Auth0 "owner" role claim and OWNER_DASHBOARD_EMAILS still make someone an
 * owner, so nobody can lock the owners out from the table.
 *
 * Signed-in people who are NOT in the table keep today's behaviour (CSR), so
 * existing CSR logins keep working without being added first. Set
 * DENNY_UNLISTED_ROLE=none once every CSR is on the Team page to block anyone
 * who has not been added.
 */
import type { SessionData } from "@auth0/nextjs-auth0/types";
import {
  findTeamMember,
  normalizeEmail,
  teamDatabaseConfigured,
  type TeamMember,
  type TeamRole,
} from "@/lib/teamStore";

export const ROLE_CLAIM = "https://dendefenders.com/mcp/roles";

export type AccessRole = TeamRole | "disabled" | "unavailable";

export type DennyAccess = {
  email: string | null;
  displayName: string;
  role: AccessRole;
  member: TeamMember | null;
  /** Set when access was refused because the Auth0 email is not verified. */
  needsEmailVerification?: boolean;
};

export const FIELD_ROLES: readonly TeamRole[] = ["sales_rep", "installer"];

export function isFieldRole(role: AccessRole): boolean {
  return role === "sales_rep" || role === "installer";
}

function claimRoles(source: unknown): string[] {
  if (!source || typeof source !== "object") return [];
  const value = (source as Record<string, unknown>)[ROLE_CLAIM];
  return Array.isArray(value) ? value.map((role) => String(role).toLowerCase()) : [];
}

function accessTokenPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function isOwnerByAuth0(session: SessionData): boolean {
  const user = session.user as Record<string, unknown>;
  if (claimRoles(user).includes("owner")) return true;
  if (claimRoles(accessTokenPayload(session.tokenSet?.accessToken)).includes("owner")) return true;

  const allowed = (process.env.OWNER_DASHBOARD_EMAILS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return user.email_verified === true &&
    typeof user.email === "string" &&
    allowed.includes(user.email.toLowerCase());
}

// Short per-instance cache so every page and image request does not hit Neon.
const CACHE_MS = 30_000;
const memberCache = new Map<string, { expiresAt: number; member: TeamMember | null }>();

export function clearAccessCache() {
  memberCache.clear();
}

async function lookupMember(email: string): Promise<TeamMember | null> {
  const key = normalizeEmail(email);
  const cached = memberCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.member;
  const member = await findTeamMember(key);
  memberCache.set(key, { expiresAt: Date.now() + CACHE_MS, member });
  return member;
}

function unlistedRole(): AccessRole {
  return (process.env.DENNY_UNLISTED_ROLE || "csr").trim().toLowerCase() === "none"
    ? "disabled"
    : "csr";
}

export async function resolveAccess(session: SessionData | null): Promise<DennyAccess | null> {
  if (!session) return null;
  const user = session.user as Record<string, unknown>;
  const email = typeof user.email === "string" ? normalizeEmail(user.email) : null;
  const emailVerified = user.email_verified === true;
  const fallbackName = typeof user.name === "string" ? user.name : email || "Teammate";

  let member: TeamMember | null = null;
  let lookupFailed = false;
  if (email && teamDatabaseConfigured()) {
    try {
      member = await lookupMember(email);
    } catch (error) {
      lookupFailed = true;
      console.error("Den team lookup failed:", error instanceof Error ? error.message : error);
    }
  }

  const displayName = member?.displayName || fallbackName;

  if (isOwnerByAuth0(session)) {
    return { email, displayName, role: "owner", member };
  }
  if (lookupFailed) {
    // Fail closed: we cannot tell whether this person is a CSR or field user.
    return { email, displayName, role: "unavailable", member: null };
  }
  if (member) {
    // Team roles are matched by email, so the email must be proven to belong
    // to this login. Otherwise anyone who signs up with a teammate's email
    // address would inherit that teammate's role.
    if (!emailVerified) {
      return { email, displayName, role: "disabled", member: null, needsEmailVerification: true };
    }
    return { email, displayName, role: member.active ? member.role : "disabled", member };
  }
  if (!teamDatabaseConfigured()) {
    return { email, displayName, role: "csr", member: null };
  }
  return { email, displayName, role: unlistedRole(), member: null };
}

// ---------------------------------------------------------------------------
// Route policy
// ---------------------------------------------------------------------------

const STAFF: readonly AccessRole[] = ["owner", "csr", "sales_rep", "installer"];

type Rule = { prefix: string; exact?: boolean; roles: readonly AccessRole[] };

const ROUTE_RULES: Rule[] = [
  // Always reachable once signed in, so the UI can explain the situation.
  { prefix: "/api/me", roles: [...STAFF, "disabled", "unavailable"] },
  { prefix: "/api/owner/access", roles: [...STAFF, "disabled", "unavailable"] },
  { prefix: "/no-access", roles: [...STAFF, "disabled", "unavailable"] },

  { prefix: "/team", roles: ["owner"] },
  { prefix: "/api/team", roles: ["owner"] },
  { prefix: "/owner", roles: ["owner"] },
  { prefix: "/api/owner", roles: ["owner"] },

  { prefix: "/talk", roles: ["owner", "sales_rep", "installer"] },
  { prefix: "/api/field-voice", roles: ["owner", "sales_rep", "installer"] },

  { prefix: "/schedule", roles: STAFF },
  { prefix: "/api/schedule", roles: STAFF },
  { prefix: "/api/location-map", roles: STAFF },
  { prefix: "/api/location-preview", roles: STAFF },

  { prefix: "/", exact: true, roles: STAFF },
];

// Anything not listed above (Chat, Let Denny Listen, their APIs, and any page
// added later) is CSR/owner only until someone deliberately opens it up.
const DEFAULT_ROLES: readonly AccessRole[] = ["owner", "csr"];

function matches(rule: Rule, pathname: string): boolean {
  if (rule.exact) return pathname === rule.prefix;
  return pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`);
}

/**
 * Public images in /public: /brand/*, /public/*, or a file at the site root
 * (e.g. /next.svg). Limited to these folders so a future dynamic page route
 * such as /owner/[id] can't be opened as /owner/x.png.
 */
function isStaticAsset(pathname: string): boolean {
  if (!/\.(png|jpe?g|gif|svg|webp|ico|txt|woff2?)$/i.test(pathname)) return false;
  if (pathname.startsWith("/brand/") || pathname.startsWith("/public/")) return true;
  return pathname.split("/").length === 2; // "/file.ext"
}

export function isPathAllowed(role: AccessRole, pathname: string): boolean {
  if (isStaticAsset(pathname)) return role !== "disabled" && role !== "unavailable";
  const rule = ROUTE_RULES.find((candidate) => matches(candidate, pathname));
  return (rule ? rule.roles : DEFAULT_ROLES).includes(role);
}

/** Where to send someone who opened a page their role cannot see. */
export function landingPathFor(role: AccessRole): string {
  if (role === "disabled" || role === "unavailable") return "/no-access";
  if (isFieldRole(role)) return "/talk";
  return "/";
}

export type NavKey = "home" | "chat" | "listen" | "schedule" | "talk" | "owner" | "team";

export function navFor(role: AccessRole): NavKey[] {
  switch (role) {
    case "owner":
      return ["home", "chat", "listen", "schedule", "talk", "owner", "team"];
    case "csr":
      return ["home", "chat", "listen", "schedule"];
    case "sales_rep":
    case "installer":
      return ["home", "schedule", "talk"];
    default:
      return [];
  }
}
