/**
 * lib/sms/place.ts
 *
 * "Roseville, CA" for a ZIP (Steven, 2026-11-16): shown under the customer's name in the
 * Texting list. Uses the same ZIP directory as the AI's service-area check, so it covers
 * every state we sell in. A ZIP that isn't in it shows as "ZIP 12345".
 */
import salesZipDirectory from "@/app/lib/salesZipDirectory.json";

const ZIPS = salesZipDirectory as unknown as Record<string, [string, string]>;

export function placeForZip(zip: string | null | undefined): string | null {
  const z = (zip || "").trim();
  if (!/^\d{5}$/.test(z)) return null;
  const hit = ZIPS[z];
  return hit ? `${hit[0]}, ${hit[1].toUpperCase()}` : `ZIP ${z}`;
}
