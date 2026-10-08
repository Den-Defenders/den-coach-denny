/**
 * lib/websiteBotGuard.ts
 *
 * Gatekeeping for the public website bot: on/off switch, which websites may
 * embed it, CORS headers, and simple rate limits.
 *
 * Rate limits are per server instance (in memory). Vercel may run several
 * instances, so treat these as a brake, not a wall. Phase 2 can move the
 * counters to Neon if abuse shows up.
 */

export function websiteBotEnabled(): boolean {
  return (process.env.WEBSITE_BOT_ENABLED || "").trim().toLowerCase() === "true";
}

export function allowedOrigins(): string[] {
  return (process.env.WEBSITE_BOT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * The browser sends an Origin header on cross-site fetches (the widget on
 * dendefenders.com calling Denny on Vercel). Accept only listed origins.
 * A request with NO origin (curl, scripts) is refused too: the bot is only
 * meant to be used from the website.
 */
export function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const normalized = origin.replace(/\/$/, "").toLowerCase();
  const list = allowedOrigins();
  if (list.includes(normalized)) return true;
  // "https://dendefenders.com" in the list also allows "https://www.dendefenders.com".
  return list.some((allowed) => {
    const host = allowed.replace(/^https?:\/\//, "");
    return normalized === `https://www.${host}` || normalized === `https://${host}`;
  });
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function hit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

// Occasionally drop expired buckets so the map does not grow forever.
let lastSweep = 0;
function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export const LIMITS = {
  messagesPerSessionPerHour: Number(process.env.WEBSITE_BOT_MAX_MESSAGES_PER_SESSION || 40),
  messagesPerIpPerHour: Number(process.env.WEBSITE_BOT_MAX_MESSAGES_PER_IP || 120),
  lookupsPerSessionPerHour: Number(process.env.WEBSITE_BOT_MAX_LOOKUPS_PER_SESSION || 6),
};

export function allowMessage(sessionId: string, ip: string): boolean {
  sweep();
  const okSession = hit(`msg:s:${sessionId}`, LIMITS.messagesPerSessionPerHour, 3_600_000);
  const okIp = hit(`msg:ip:${ip}`, LIMITS.messagesPerIpPerHour, 3_600_000);
  return okSession && okIp;
}

export function allowLookup(sessionId: string): boolean {
  return hit(`lookup:s:${sessionId}`, LIMITS.lookupsPerSessionPerHour, 3_600_000);
}

export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for") || "";
  const first = forwarded.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "unknown";
}
