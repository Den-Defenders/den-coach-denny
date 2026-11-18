import { getCurrentAccess } from "@/lib/currentAccess";

/**
 * Deny by default. Owner = Auth0 "owner" role claim, a verified email in
 * OWNER_DASHBOARD_EMAILS, or an active "owner" row on the Team page
 * (see lib/access.ts).
 */
export async function canViewOwner(): Promise<boolean> {
  const access = await getCurrentAccess();
  return access?.role === "owner";
}

/** Texting setup & test page and Lead results: owners and managers (Steven, 2026-11-18). */
export async function textingAdminRole(): Promise<"owner" | "manager" | null> {
  const access = await getCurrentAccess();
  return access?.role === "owner" || access?.role === "manager" ? access.role : null;
}
