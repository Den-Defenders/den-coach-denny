/**
 * lib/websiteBotMcp.ts
 *
 * The ONLY way the public website bot touches the ServiceTitan MCP.
 *
 * Differences from the signed-in Denny code (lib/mcpJson.ts):
 *   - No person is logged in. The bot uses its own Auth0 machine-to-machine
 *     credential (WEBSITE_BOT_AUTH0_CLIENT_ID / _SECRET) to get a token for
 *     the MCP. That Auth0 application should be given the narrowest access
 *     the MCP allows (read scope now; the booking role in Phase 2).
 *   - Its own tiny allow-list. Phase 1 = recommend_sales_schedule only.
 *   - Results are REDUCED before anything reaches the chat model. The raw
 *     scheduler output names our sales reps, other customers' addresses and
 *     routing details. A website visitor must never see any of that, so only
 *     {date, weekday, arrivalWindow} survive.
 */
import { connectServiceTitanMcp } from "@/lib/serviceTitanMcp";

export const WEBSITE_BOT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "recommend_sales_schedule",
]);

const MCP_AUDIENCE = "https://servicetitan-mcp-alpha.vercel.app/mcp";

// ---------------------------------------------------------------------------
// Machine-to-machine token (cached per server instance until near expiry)
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null;

export class WebsiteBotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsiteBotConfigError";
  }
}

function auth0Domain(): string {
  const raw = (process.env.AUTH0_DOMAIN || "").trim();
  if (!raw) throw new WebsiteBotConfigError("AUTH0_DOMAIN is not set.");
  return raw.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export async function getWebsiteBotMcpToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const clientId = (process.env.WEBSITE_BOT_AUTH0_CLIENT_ID || "").trim();
  const clientSecret = (process.env.WEBSITE_BOT_AUTH0_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new WebsiteBotConfigError(
      "WEBSITE_BOT_AUTH0_CLIENT_ID / WEBSITE_BOT_AUTH0_CLIENT_SECRET are not set."
    );
  }

  const res = await fetch(`https://${auth0Domain()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: MCP_AUDIENCE,
    }),
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    console.error("Website bot Auth0 token request failed:", res.status, data.error, data.error_description);
    throw new Error("Could not get a ServiceTitan MCP token for the website bot.");
  }

  const ttlSeconds = typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedToken = { value: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
  return cachedToken.value;
}

// ---------------------------------------------------------------------------
// Open appointment times, reduced to what a visitor may see
// ---------------------------------------------------------------------------

export type PublicTimeOption = {
  date: string;        // YYYY-MM-DD
  weekday: string;     // Monday ... Friday
  arrivalWindow: string; // "8 AM - 12 PM" etc.
};

export type PublicAvailability = {
  status: "options" | "none" | "outside_service_area";
  options: PublicTimeOption[];
};

export type AvailabilityRequest = {
  location: string;           // ZIP, "City, ST" or full address
  earliestStartTime?: string; // HH:mm
  latestStartTime?: string;   // HH:mm
  requestedWeekdays?: string[];
  requestedDates?: string[];
  maxOptions?: number;
};

/**
 * Same windows the booking tool uses: 8-12, 10-2 or 12-4 containing the start;
 * 2-6 for starts at 4:00 PM or later.
 */
export function arrivalWindowForStart(hhmm: string): string {
  const [h] = hhmm.split(":").map(Number);
  if (h >= 16) return "2 PM - 6 PM";
  if (h >= 12) return "12 PM - 4 PM";
  if (h >= 10) return "10 AM - 2 PM";
  return "8 AM - 12 PM";
}

type RawOption = {
  date?: string;
  dayOfWeek?: string;
  localStart?: string; // "YYYY-MM-DD HH:mm"
};

type RawResult = {
  recommendationStatus?: string;
  optionCount?: number;
  options?: RawOption[];
};

export function reduceAvailability(raw: unknown): PublicAvailability {
  const result = (raw && typeof raw === "object" ? raw : {}) as RawResult;
  const status = String(result.recommendationStatus || "");

  if (/outside service area/i.test(status)) {
    return { status: "outside_service_area", options: [] };
  }

  const seen = new Set<string>();
  const options: PublicTimeOption[] = [];

  for (const option of result.options || []) {
    if (!option?.date || !option.localStart) continue;
    const time = option.localStart.split(" ")[1] || "08:00";
    const window = arrivalWindowForStart(time);
    const key = `${option.date}|${window}`;
    if (seen.has(key)) continue; // two reps free in the same window = one choice for the visitor
    seen.add(key);
    options.push({
      date: option.date,
      weekday: option.dayOfWeek || weekdayOf(option.date),
      arrivalWindow: window,
    });
  }

  return { status: options.length ? "options" : "none", options };
}

function weekdayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
}

export async function findOpenSalesTimes(request: AvailabilityRequest): Promise<PublicAvailability> {
  const toolName = "recommend_sales_schedule";
  if (!WEBSITE_BOT_TOOL_ALLOWLIST.has(toolName)) {
    throw new Error(`Tool ${toolName} is not allowed for the website bot.`);
  }

  const token = await getWebsiteBotMcpToken();
  const client = await connectServiceTitanMcp(token);

  try {
    const args: Record<string, unknown> = {
      appointmentLocation: request.location,
      maxRecommendations: Math.min(Math.max(request.maxOptions ?? 3, 1), 6),
    };
    if (request.earliestStartTime) args.earliestStartTime = request.earliestStartTime;
    if (request.latestStartTime) args.latestStartTime = request.latestStartTime;
    if (request.requestedWeekdays?.length) args.requestedWeekdays = request.requestedWeekdays;
    if (request.requestedDates?.length) args.requestedDates = request.requestedDates;

    const result = (await client.callTool({ name: toolName, arguments: args }, { timeout: 90_000 })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };

    const text = (result.content || [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");

    if (result.isError) {
      console.error("Website bot recommend_sales_schedule failed:", text.slice(0, 1000));
      throw new Error("Scheduler lookup failed.");
    }

    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return reduceAvailability(parsed);
  } finally {
    await client.close().catch(() => undefined);
  }
}
