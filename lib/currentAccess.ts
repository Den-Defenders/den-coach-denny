import { auth0 } from "@/lib/auth0";
import { resolveAccess, type DennyAccess } from "@/lib/access";

/** Access for the person making the current request (server components and API routes). */
export async function getCurrentAccess(): Promise<DennyAccess | null> {
  return resolveAccess(await auth0.getSession());
}

/**
 * Second gate for API routes (proxy.ts is the first). Returns true when the
 * signed-in person has one of these roles.
 */
export async function currentUserHasRole(roles: readonly string[]): Promise<boolean> {
  const access = await getCurrentAccess();
  return Boolean(access && roles.includes(access.role));
}
