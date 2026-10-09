/**
 * lib/websiteBotMcp.ts
 *
 * The ONLY way the public website bot touches the ServiceTitan MCP.
 *
 * Differences from the signed-in Denny code (lib/mcpJson.ts):
 *   - No person is logged in. The bot uses its own Auth0 machine-to-machine
 *     credential (WEBSITE_BOT_AUTH0_CLIENT_ID / _SECRET) to get a token for
 *     the MCP. That Auth0 application is given the narrowest access the MCP
 *     allows.
 *   - Its own tiny allow-lists: one read tool (recommend_sales_schedule) and
 *     one write tool (book_sales_appointment). Nothing else, ever.
 *   - Scheduler results are REDUCED before anything reaches the chat model.
 *     The raw output names our sales reps, other customers' addresses and
 *     routing details. A website visitor must never see any of that, so only
 *     {date, weekday, arrivalWindow} survive. The rep is re-resolved on the
 *     server at booking time.
 */
import { connectServiceTitanMcp } from "@/lib/serviceTitanMcp";

export const WEBSITE_BOT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "recommend_sales_schedule",
  // Returning-customer lookup. Results are reduced to a first name, a short
  // product list and server-only IDs before the chat model sees anything.
  "search_customers",
  "get_customer_jobs",
  "get_job_invoices",
]);

export const WEBSITE_BOT_WRITE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "book_sales_appointment",
  "add_job_note", // only to save the chat transcript on the job it just booked
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

/** Thrown when the MCP refuses or fails a call. `code` is safe to branch on. */
export class WebsiteBotMcpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WebsiteBotMcpError";
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
// Shared MCP call
// ---------------------------------------------------------------------------

type McpResult = { isError?: boolean; content?: { type: string; text?: string }[] };

async function callWebsiteBotTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  if (!WEBSITE_BOT_TOOL_ALLOWLIST.has(name) && !WEBSITE_BOT_WRITE_TOOL_ALLOWLIST.has(name)) {
    throw new WebsiteBotMcpError("TOOL_NOT_ALLOWED", `Tool ${name} is not allowed for the website bot.`);
  }

  const token = await getWebsiteBotMcpToken();
  const client = await connectServiceTitanMcp(token);

  try {
    let result: McpResult;
    try {
      result = (await client.callTool({ name, arguments: args }, { timeout: timeoutMs })) as McpResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Website bot MCP call ${name} failed:`, message);
      const refused = /\b403\b|forbidden|does not have a role|requires the owner|not found|unknown tool/i.test(message);
      throw new WebsiteBotMcpError(refused ? "NOT_ALLOWED" : "CALL_FAILED", message);
    }

    const text = (result.content || [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");

    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }

    if (result.isError) {
      const code = parsed && typeof parsed === "object" ? (parsed as { error?: string }).error : undefined;
      console.error(`Website bot MCP tool ${name} returned an error:`, text.slice(0, 1500));
      throw new WebsiteBotMcpError(code || "TOOL_ERROR", text.slice(0, 500));
    }
    return parsed;
  } finally {
    await client.close().catch(() => undefined);
  }
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

/** Public label -> the booking tool's arrivalWindow enum. */
export function bookingWindowCode(label: string): "8-12" | "10-2" | "12-4" | "2-6" | null {
  switch (label.replace(/\s+/g, " ").trim()) {
    case "8 AM - 12 PM": return "8-12";
    case "10 AM - 2 PM": return "10-2";
    case "12 PM - 4 PM": return "12-4";
    case "2 PM - 6 PM": return "2-6";
    default: return null;
  }
}

type RawOption = {
  date?: string;
  dayOfWeek?: string;
  consultantName?: string;
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

function schedulerArgs(request: AvailabilityRequest): Record<string, unknown> {
  const args: Record<string, unknown> = {
    appointmentLocation: request.location,
    maxRecommendations: Math.min(Math.max(request.maxOptions ?? 3, 1), 6),
  };
  if (request.earliestStartTime) args.earliestStartTime = request.earliestStartTime;
  if (request.latestStartTime) args.latestStartTime = request.latestStartTime;
  if (request.requestedWeekdays?.length) args.requestedWeekdays = request.requestedWeekdays;
  if (request.requestedDates?.length) args.requestedDates = request.requestedDates;
  return args;
}

export async function findOpenSalesTimes(request: AvailabilityRequest): Promise<PublicAvailability> {
  const raw = await callWebsiteBotTool("recommend_sales_schedule", schedulerArgs(request), 90_000);
  return reduceAvailability(raw);
}

// ---------------------------------------------------------------------------
// Booking (Phase 2)
// ---------------------------------------------------------------------------

/** The server-side facts needed to book: never shown to the visitor. */
export type ResolvedSlot = {
  consultantName: string;
  date: string;      // YYYY-MM-DD
  startTime: string; // HH:mm local to the rep
  arrivalWindow: "8-12" | "10-2" | "12-4" | "2-6";
};

/**
 * The visitor only ever saw {date, arrivalWindow}. Re-run the live scheduler
 * for the exact street address and that date, and pick the option whose start
 * falls in the chosen window. Returns null when the slot is no longer open.
 */
export async function resolveSlotForBooking(
  fullAddress: string,
  date: string,
  arrivalWindowLabel: string
): Promise<ResolvedSlot | null> {
  const code = bookingWindowCode(arrivalWindowLabel);
  if (!code) return null;

  const raw = (await callWebsiteBotTool(
    "recommend_sales_schedule",
    { appointmentLocation: fullAddress, requestedDates: [date], maxRecommendations: 6 },
    90_000
  )) as RawResult;

  for (const option of raw?.options || []) {
    if (!option?.date || !option.localStart || !option.consultantName) continue;
    if (option.date !== date) continue;
    const time = option.localStart.split(" ")[1] || "";
    if (arrivalWindowForStart(time) !== arrivalWindowLabel) continue;
    return { consultantName: option.consultantName, date, startTime: time, arrivalWindow: code };
  }
  return null;
}

export type BookingCustomer = {
  name: string;
  phone: string;
  email?: string;
  street: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
};

export type BookingQualifying = {
  reason?: string;
  priority?: string;
  otherOptions?: string;
  timeline?: string;
  entryPoints?: string;
  decisionMakers?: string;
  heardAboutUs?: string;
  priceRange?: string;
  parking?: string;
  callAttached?: string;
};

export type BookingResult = {
  ok: boolean;
  code?: string;
  jobId?: number;
  jobNumber?: string;
  raw?: unknown;
};

/**
 * Calls the MCP's book_sales_appointment. With dryRun=true nothing is written
 * (the MCP re-checks the slot and returns a preview). With dryRun=false and
 * confirm=true the appointment is created in ServiceTitan.
 */
export async function bookSalesAppointmentFromWebsite(input: {
  slot: ResolvedSlot;
  customer: BookingCustomer;
  qualifying: BookingQualifying;
  customerNotes?: string;
  dryRun: boolean;
  /** Set for a returning customer: book under their existing ServiceTitan record. */
  existing?: { customerId: number; locationId?: number };
}): Promise<BookingResult> {
  const args: Record<string, unknown> = {
    consultantName: input.slot.consultantName,
    date: input.slot.date,
    startTime: input.slot.startTime,
    arrivalWindow: input.slot.arrivalWindow,
    ...(input.existing
      ? {
          customerId: input.existing.customerId,
          ...(input.existing.locationId ? { locationId: input.existing.locationId } : {}),
        }
      : {
          newCustomer: {
            name: input.customer.name,
            phone: input.customer.phone,
            phoneType: "MobilePhone",
            ...(input.customer.email ? { email: input.customer.email } : {}),
            street: input.customer.street,
            ...(input.customer.unit ? { unit: input.customer.unit } : {}),
            city: input.customer.city,
            state: input.customer.state.toUpperCase(),
            zip: input.customer.zip,
          },
        }),
    qualifying: input.qualifying,
    ...(input.customerNotes ? { customerNotes: input.customerNotes.slice(0, 1000) } : {}),
    dryRun: input.dryRun,
    confirm: !input.dryRun,
  };

  try {
    const raw = await callWebsiteBotTool("book_sales_appointment", args, 120_000);
    const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const jobId = typeof record.jobId === "number" ? record.jobId : undefined;
    const jobNumber =
      (typeof record.jobNumber === "string" && record.jobNumber) ||
      (jobId ? String(jobId) : undefined);
    return { ok: true, jobId, jobNumber, raw };
  } catch (error) {
    if (error instanceof WebsiteBotMcpError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
}

/**
 * Saves the chat transcript as a note on the job the bot just booked.
 * Best-effort: a failure here never undoes or hides a successful booking.
 */
export async function addWebsiteChatNote(jobId: number, text: string): Promise<boolean> {
  try {
    await callWebsiteBotTool(
      "add_job_note",
      { jobId, text: text.slice(0, 4000), pinToTop: false, dryRun: false, confirm: true },
      60_000
    );
    return true;
  } catch (error) {
    console.error("Website bot chat note failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Returning customers
// ---------------------------------------------------------------------------

/** Server-side facts about a matched customer. customerId never reaches the model. */
export type ReturningCustomer = {
  customerId: number;
  locationId?: number;
  firstName: string;
  fullName: string;
  zip?: string;
  products: string[];       // e.g. ["Two Panel Sliding Security Door"]
  lastCompleted?: string;   // "June 2026"
};

type SearchCustomer = {
  customerId?: number;
  customerName?: string;
  active?: boolean;
  billingAddress?: string;
  matches?: { matchType?: string; locationId?: number | null }[];
};

type CustomerJob = {
  jobId?: number;
  status?: string;
  locationId?: number;
  total?: number;
  completedOn?: string | null;
  createdOn?: string;
};

function zipOf(address: string | undefined): string | undefined {
  const m = (address || "").match(/\b(\d{5})(?:-\d{4})?\b\s*$/);
  return m ? m[1] : undefined;
}

function firstNameOf(customerName: string): string {
  // "Anna & Steven Williams" -> "Anna"; "Santiago Saiz" -> "Santiago"
  const cleaned = customerName.replace(/[&,/]/g, " ").trim();
  return cleaned.split(/\s+/)[0] || "there";
}

function monthYear(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "America/Los_Angeles" }).format(d);
}

const PRODUCT_WORDS = /door|screen|window|slider|centurion|artisan|storm/i;
const HARDWARE_WORDS = /handle|deadbolt|threshold|fee|charge|bucks|discount|extension|lock/i;

/**
 * Find a returning customer by the phone or email THEY typed, tie-breaking on
 * last name and ZIP when several records share the number. Returns null when
 * there is no confident single match (the chat then treats them as new).
 */
export type LookupOutcome =
  | { status: "matched"; customer: ReturningCustomer }
  | { status: "none" }
  | { status: "ambiguous" }; // several records share the number; need last name or ZIP

const NOT_A_HOMEOWNER = /showroom|office|test|warehouse|den defenders|sample/i;

export async function lookupReturningCustomer(input: {
  phone?: string;
  email?: string;
  lastName?: string;
  zip?: string;
}): Promise<LookupOutcome> {
  const query = input.phone || input.email;
  if (!query) return { status: "none" };

  const raw = (await callWebsiteBotTool(
    "search_customers",
    { query, searchType: input.phone ? "phone" : "auto" },
    60_000
  )) as { customers?: SearchCustomer[] };

  let candidates = (raw?.customers || []).filter((c) => c.customerId && c.active !== false && c.customerName);
  console.info(`Website bot customer lookup: ${candidates.length} raw candidate(s)`);
  if (!candidates.length) return { status: "none" };

  // Internal records (showroom, office, test accounts) sometimes share a number.
  if (candidates.length > 1) {
    const homeowners = candidates.filter((c) => !NOT_A_HOMEOWNER.test(c.customerName || ""));
    if (homeowners.length) candidates = homeowners;
  }

  if (candidates.length > 1 && input.lastName) {
    const wanted = input.lastName.toLowerCase();
    const byName = candidates.filter((c) => (c.customerName || "").toLowerCase().includes(wanted));
    if (byName.length) candidates = byName;
  }
  if (candidates.length > 1 && input.zip) {
    const byZip = candidates.filter((c) => zipOf(c.billingAddress) === input.zip);
    if (byZip.length) candidates = byZip;
  }
  if (candidates.length !== 1) {
    console.info(`Website bot customer lookup: ${candidates.length} candidates after tie-break, not confident`);
    return { status: "ambiguous" };
  }

  const customer = candidates[0];
  const customerId = customer.customerId as number;

  const jobsRaw = (await callWebsiteBotTool("get_customer_jobs", { customerId, pageSize: 50 }, 60_000)) as {
    jobs?: CustomerJob[];
  };
  const jobs = jobsRaw?.jobs || [];

  // Most recent location on file (any non-canceled job wins, newest first).
  const locationId =
    jobs.find((j) => j.status !== "Canceled" && j.locationId)?.locationId ??
    jobs.find((j) => j.locationId)?.locationId ??
    customer.matches?.find((m) => m.locationId)?.locationId ??
    undefined;

  // Products: Service-type invoice lines on completed, paid jobs (newest 3).
  const completed = jobs
    .filter((j) => j.status === "Completed" && (j.total || 0) > 0 && j.jobId)
    .sort((a, b) => String(b.completedOn || "").localeCompare(String(a.completedOn || "")))
    .slice(0, 3);

  const products: string[] = [];
  for (const job of completed) {
    try {
      const inv = (await callWebsiteBotTool("get_job_invoices", { jobId: job.jobId, includeInactive: false }, 60_000)) as {
        invoices?: { items?: { type?: string; displayName?: string; skuName?: string }[] }[];
      };
      for (const invoice of inv?.invoices || []) {
        for (const item of invoice.items || []) {
          const name = (item.displayName || item.skuName || "").trim();
          if (!name || item.type !== "Service") continue;
          if (!PRODUCT_WORDS.test(name) || HARDWARE_WORDS.test(name)) continue;
          if (!products.includes(name)) products.push(name);
        }
      }
    } catch (error) {
      console.warn("Website bot product lookup skipped a job:", error instanceof Error ? error.message : error);
    }
    if (products.length >= 3) break;
  }

  return {
    status: "matched",
    customer: {
      customerId,
      locationId,
      firstName: firstNameOf(customer.customerName || ""),
      fullName: (customer.customerName || "").trim(),
      zip: zipOf(customer.billingAddress),
      products,
      lastCompleted: monthYear(completed[0]?.completedOn),
    },
  };
}
