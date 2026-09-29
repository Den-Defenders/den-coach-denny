import { auth0 } from "@/lib/auth0";

const ROLE_CLAIM = "https://dendefenders.com/mcp/roles";

function tokenRoles(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Array.isArray(payload[ROLE_CLAIM]) ? payload[ROLE_CLAIM] : [];
  } catch {
    return [];
  }
}

/** Deny by default. Auth0 issues the token through the authenticated server session. */
export async function canViewOwner(): Promise<boolean> {
  const session = await auth0.getSession();
  if (!session) return false;
  const user = session.user as Record<string, unknown>;
  const roles = Array.isArray(user[ROLE_CLAIM]) ? user[ROLE_CLAIM] : [];
  if (roles.some((role) => String(role).toLowerCase() === "owner")) return true;

  try {
    const response = await auth0.getAccessToken();
    if (tokenRoles(response.token).some((role) => String(role).toLowerCase() === "owner")) return true;
  } catch { /* No usable owner claim. */ }

  const allowed = (process.env.OWNER_DASHBOARD_EMAILS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return user.email_verified === true &&
    typeof user.email === "string" && allowed.includes(user.email.toLowerCase());
}
